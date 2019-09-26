import * as Hapi from '@hapi/hapi'
import Boom from '@hapi/boom'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { Injector } from 'reduct'
import ProxyComponent from '../public/components/Proxy'
import Config from '../services/Config'

const Proxy = React.createFactory(ProxyComponent)
const PROXY_SUBDOMAIN_REGEX = /^proxy-[a-zA-Z2-7]{52}$/
const MANIFEST_SUBDOMAIN_REGEX = /^[a-zA-Z2-7]{52}$/

const proxyPath = '/proxy'
const proxyPagePath = '/proxypage'

import { create as createLogger } from '../common/log'
const log = createLogger('proxy')

// Containers are accessed from the browser at:
//
//   https://hash.host-domain/path
//
// onRequest modifies the path to be handled by the proxy page route:
//
//   https://hash.host-domain/proxypage/path
//
// The web-monetized proxy page accesses the container at:
//
//   https://proxy-hash.hostdomain/path
//
// onRequest modifies the path to be handled by the proxy route:
//
//   http://proxy-hash.host-domain/proxy/path
//
// The server proxies the request to k8s/knative at:
//
//   http://proxy-hash.namespace.svc.cluster.local/path

export default function (server: Hapi.Server, deps: Injector) {
  const config = deps(Config)

  function isProxyRequest (host: string): boolean {
    return !!PROXY_SUBDOMAIN_REGEX.exec(host.split('.')[0])
  }

  function isProxyPageRequest (host: string): boolean {
    return !!MANIFEST_SUBDOMAIN_REGEX.exec(host.split('.')[0])
  }

  async function onRequest (request: Hapi.Request, h: Hapi.ResponseToolkit) {
    const host = request.info.host

    if (isProxyRequest(host)) {
      request.setUrl(`http://${request.info.host}${proxyPath}${request.path}`)
    } else if (isProxyPageRequest(host)) {
      request.setUrl(`http://${request.info.host}${proxyPagePath}${request.path}`)
    }

    return h.continue
  }

  async function getProxyPage (request: Hapi.Request, h: Hapi.ResponseToolkit) {
    const host = request.info.host

    if (!isProxyPageRequest(host)) {
      throw Boom.notFound()
    }

    const state = {
      proxySrc: `${new URL(config.publicUri).protocol}//proxy-${request.info.host}/${request.params.path}`
    }

    return h.view('index', {
      // Use publicUri instead of current subdomain so onRequest doesn't change the path
      assets: `${config.publicUri}/assets/proxy.bundle.js`,
      component: renderToString(Proxy(state)),
      paymentPointer: config.paymentPointer,
      state: `window.__INITIAL_PROPS__ = ${JSON.stringify(state)}`
    })
  }

  async function proxy (request: Hapi.Request, h: Hapi.ResponseToolkit) {
    const host = request.info.host

    if (!isProxyRequest(host)) {
      throw Boom.notFound()
    }

    try {
      return h.proxy({
        uri: `http://${host.split('.')[0]}.${config.k8sNamespace}.svc.cluster.local/${request.params.path}`,
        passThrough: true
      })
    } catch (e) {
      log.error(e)
      Boom.serverUnavailable()
    }
  }

  server.ext('onRequest', onRequest)

  server.route({
    method: 'GET',
    path: `${proxyPagePath}/{path*}`,
    handler: getProxyPage
  })

  server.route({
    method: '*',
    path: `${proxyPath}/{path*}`,
    handler: proxy,
    options: {
      payload: {
        parse: false
      }
    }
  })
}
