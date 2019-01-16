import * as Hapi from 'hapi'
import * as Boom from 'boom'
import { IncomingMessage } from 'http'
import { Socket } from 'net'
import { Injector } from 'reduct'
import PodDatabase from '../services/PodDatabase'

const HttpProxy = require('http-proxy')
const MANIFEST_LABEL_REGEX = /^[a-zA-Z2-7]{52}(\/|\?|$)/

import { create as createLogger } from '../common/log'
const log = createLogger('proxy')

export default function (server: Hapi.Server, deps: Injector) {
  const pods = deps(PodDatabase)
  const proxy = HttpProxy.createProxyServer({
    ws: true // allow websockets
  })

  function isPodRequest (path: string): boolean {
    return !!MANIFEST_LABEL_REGEX.exec(path.split('/')[1])
  }

  function getPod (path: string): string {
    const label = path.split('/')[1].slice(0, 52)
    const pod = pods.getPod(label)

    if (!pod || !pod.ip || !pod.port) {
      throw Boom.notFound('no pod with that hash found. ' +
        `hash=${label}`)
    }
    log.debug('podIP', pod.ip, pod.port)
    return `http://${pod.ip}:${pod.port}`
  }

  async function proxyToPod (request: Hapi.Request, h: any) {
    const path = request.path

    if (!isPodRequest(path)) {
      return h.continue
    }

    const target = getPod(path)
    await new Promise((resolve, reject) => {
      if (request.raw.req.url) {
        request.raw.req.url = request.raw.req.url.slice(53)
      }
      proxy.web(request.raw.req, request.raw.res, { target }, (e: any) => {
        const statusError = {
          ECONNREFUSED: Boom.serverUnavailable(),
          ETIMEOUT: Boom.gatewayTimeout()
        }[e.code]

        if (statusError) {
          reject(statusError)
        }

        resolve()
      })
    })
  }

  function writeError (socket: Socket, code: number, error: string): void {
    socket.write(`HTTP/1.1 ${code} ${error}\r\n`)
    socket.end()
  }

  async function wsProxyToPod (req: IncomingMessage, socket: Socket, head: Buffer) {
    socket.on('error', (e: Error) => {
      if (e.message !== 'read ECONNRESET') {
        log.debug(`socket error. msg=${e.message}`)
      }
    })

    if (!req.url || !isPodRequest(req.url)) {
      writeError(socket, 502, 'Bad Gateway')
      return
    }

    try {
      const target = getPod(req.url)
      req.url = req.url.slice(53)
      proxy.ws(req, socket, head, { target }, (error: Error) => {
        if (error.message !== 'socket hang up') {
          log.debug(`error in ws proxy. error="${error.message}"`)
        }
      })
    } catch (e) {
      if (e.isBoom) {
        writeError(socket, e.output.statusCode, e.output.payload.error)
        return
      } else {
        throw e
      }
    }
  }

  server.listener.on('upgrade', wsProxyToPod)
  server.ext('onRequest', proxyToPod)
}
