import * as Hapi from 'hapi'
import * as Boom from 'boom'
import { URL } from 'url'
import { Injector } from 'reduct'
import { PodRequest } from '../schemas/PodRequest'
import { PodSpec } from '../schemas/PodSpec'
import Config from '../services/Config'
import Ildcp from '../services/Ildcp'
import PodManager from '../services/PodManager'
import { checkMemory } from '../util/podResourceCheck'
import { getCurrencyPerSecond } from '../util/priceRate'
import PodDatabase from '../services/PodDatabase'
import ManifestDatabase from '../services/ManifestDatabase'
import CodiusDB from '../util/CodiusDB'
import ManifestParser from '../services/ManifestParser'
import PullPaymentManager from '../services/PullPaymentManager'
import * as SPSP from 'ilp-protocol-spsp'
import { RecurringPull } from 'ilp-pull-manager'
import os = require('os')
import * as moment from 'moment'
const Enjoi = require('enjoi')
const PodRequest = require('../schemas/PodRequest.json')
import BigNumber from 'bignumber.js'

import { create as createLogger } from '../common/log'
const log = createLogger('pods')

export interface PostPodResponse {
  url: string,
  manifestHash: string,
  expiry: string
}

const payMethods = {
  PULL: 'interledger-pull',
  STREAM: 'interledger-stream'
}

export default function (server: Hapi.Server, deps: Injector) {
  const podManager = deps(PodManager)
  const podDatabase = deps(PodDatabase)
  const pullPaymentManager = deps(PullPaymentManager)
  const manifestDatabase = deps(ManifestDatabase)
  const manifestParser = deps(ManifestParser)
  const config = deps(Config)
  const ildcp = deps(Ildcp)
  const codiusdb = deps(CodiusDB)

  const minDuration = moment.duration(config.minDuration).asSeconds()
  const defaultDuration = moment.duration(config.defaultDuration).asSeconds()

  pullPaymentManager.on('pullPayment', async (manifestHash: string, pullPayment: RecurringPull, totalReceived: string) => {
    await addProfit(totalReceived)
    const duration = moment.duration(pullPayment.interval).asSeconds()
    const adjustedDuration = new BigNumber(totalReceived).dividedBy(pullPayment.amount).times(duration)
    await this.podDatabase.addDurationToPod(manifestHash, adjustedDuration.toString())
  })

  function getPodUrl (manifestHash: string): string {
    const hostUrl = new URL(config.publicUri)
    hostUrl.host = manifestHash + '.' + hostUrl.host
    return hostUrl.href
  }

  function checkIfHostFull (podSpec: PodSpec) {
    const totalMem = os.totalmem()
    const totalPodMem = checkMemory(podSpec.resource)
    if ((podManager.getMemoryUsed() + totalPodMem) * (2 ** 20) / totalMem > config.maxMemoryFraction) {
      return true
    }
    return false
  }

  function getPrice (duration: number): BigNumber {
    const currencyPerSecond = getCurrencyPerSecond(config, ildcp)
    return currencyPerSecond.times(duration).integerValue(BigNumber.ROUND_CEIL)
  }

  function addProfit (totalReceived: string): Promise<void> {
    return codiusdb.addProfit(ildcp.getAssetCode(), ildcp.getAssetScale(), totalReceived)
    .catch((err) => {
      log.error('errors updating profit. error=' + err.message)
    })
  }

  async function chargeForDuration (request: any, manifestHash: string): Promise<number> {
    if (request.headers['pay-accept'] === undefined ||
      request.headers['pay-accept'].indexOf(payMethods.STREAM) !== -1) {
      const duration = request.query['duration'] ? Math.min(Number(request.query['duration']), minDuration) : defaultDuration
      const price = getPrice(duration)
      log.debug('got pod request. duration=' + duration + ' price=' + price.toString())
      await streamForRequest(request, price)
      return duration
    } else if (request.headers['pay-accept'].indexOf(payMethods.PULL) !== -1) {
      if (request.query['duration']) {
        const duration = Math.min(Number(request.query['duration']), minDuration)
        const price = getPrice(duration)
        log.debug('got pod request. duration=' + duration + ' price=' + price.toString())
        await pullForRequest(request, price)
        return duration
      } else {
        const duration = minDuration
        const price = getPrice(duration)
        log.debug('got pod request. duration=' + duration + ' price=' + price.toString())
        await pullRecurringlyForRequest(request, manifestHash, price)
        // TODO: add grace period buffer
        return duration
      }
    } else {
      const error = Boom.paymentRequired()
      error.output.headers['Pay'] = payMethods.STREAM
      throw error
    }
  }

  async function streamForRequest (request: any, price: BigNumber.Value): Promise<void> {
    try {
      if (!request.headers['pay-token']) {
        throw Boom.paymentRequired()
      }
      const stream = request.ilpStream()
      try {
        await stream.receiveTotal(price, {
          timeout: config.paymentTimeout
        })
      } catch (e) {
        log.error('error receiving payment. error=' + e.message)
        throw Boom.paymentRequired('Failed to get payment before timeout')
      } finally {
        // TODO: Refund received amount
        await addProfit(stream.totalReceived)
      }
    } catch (e) {
      if (!e.output.headers['Pay']) {
        e.output.headers['Pay'] = payMethods.STREAM
      } else {
        const payHeader = e.output.headers['Pay'].split(' ')
        if (payHeader.length === 3) {
          e.output.headers['Interledger-Stream-Destination-Account'] = payHeader[1]
          e.output.headers['Interledger-Stream-Shared-Secret'] = payHeader[2]
        }
      }
      e.output.headers['Interledger-Stream-Price'] = price.toString()
      e.output.headers['Interledger-Stream-Asset-Code'] = ildcp.getAssetCode()
      e.output.headers['Interledger-Stream-Asset-Scale'] = ildcp.getAssetScale().toString()
      throw e
    }
  }

  async function pullForRequest (request: any, price: BigNumber): Promise<void> {
    try {
      if (!request.headers['pay-token']) {
        throw new Error()
      }
      const { totalReceived } = await SPSP.pull({
        pointer: request.headers['pay-token'],
        amount: price.toNumber()
      }, {
        timeout: config.paymentTimeout
      })
      await addProfit(totalReceived)
    } catch (e) {
      if (e instanceof SPSP.PaymentError) {
        await addProfit(e.totalReceived)
      }
      const error = Boom.paymentRequired()
      error.output.headers['Pay'] = payMethods.PULL
      error.output.headers['Interledger-Pull-Price'] = price.toString()
      error.output.headers['Interledger-Pull-Asset-Code'] = ildcp.getAssetCode()
      error.output.headers['Interledger-Pull-Asset-Scale'] = ildcp.getAssetScale().toString()
      throw error
    }
  }

  async function pullRecurringlyForRequest (request: any, manifestHash: string, price: BigNumber, interval: string = config.minDuration): Promise<void> {
    try {
      if (!request.headers['pay-token']) {
        throw new Error()
      }
      // TODO: add automatic retry instructions
      if (!await pullPaymentManager.startRecurringPull(manifestHash, {
        pointer: request.headers['pay-token'],
        amount: price.toNumber(),
        interval,
        timeout: config.paymentTimeout
      })) {
        throw new Error()
      }
    } catch (e) {
      const error = Boom.paymentRequired()
      error.output.headers['Pay'] = payMethods.PULL
      error.output.headers['Interledger-Pull-Price'] = price.toString()
      error.output.headers['Interledger-Pull-Asset-Code'] = ildcp.getAssetCode()
      error.output.headers['Interledger-Pull-Asset-Scale'] = ildcp.getAssetScale().toString()
      error.output.headers['Interledger-Pull-Interval'] = interval
      throw error
    }
  }

  // TODO: how to add plugin decorate functions to Hapi.Request type
  async function postPod (request: any, h: Hapi.ResponseToolkit): Promise<PostPodResponse> {
    const podSpec = manifestParser.manifestToPodSpec(
      request.payload['manifest'],
      request.payload['private'] || {}
    )

    // throw error if memory usage exceeds available memory
    if (checkIfHostFull(podSpec)) {
      throw Boom.serverUnavailable('Memory usage exceeded. Send pod request later.')
    }

    const duration = await chargeForDuration(request, podSpec.id)

    await podManager.startPod(podSpec, duration,
      request.payload['manifest']['port'])

    await manifestDatabase.saveManifest(podSpec.id, request.payload['manifest'])

    // return info about running pod to uploader
    const podInfo = podDatabase.getPod(podSpec.id)

    if (!podInfo) {
      throw Boom.serverUnavailable('pod has stopped. ' +
        `manifestHash=${podSpec.id}`)
    }

    return {
      url: getPodUrl(podInfo.id),
      manifestHash: podInfo.id,
      expiry: podInfo.expiry
    }
  }

  async function extendPod (request: any, h: Hapi.ResponseToolkit) {
    const manifestHash = request.query['manifestHash']
    if (!manifestHash) {
      throw Boom.badData('manifestHash must be specified')
    }

    if (!request.query['duration']) {
      throw Boom.badData('duration must be specified')
    }

    const duration = await chargeForDuration(request, manifestHash)

    await podDatabase.addDurationToPod(manifestHash, duration)

    const podInfo = podDatabase.getPod(manifestHash)
    if (!podInfo) {
      throw Boom.serverUnavailable('pod has stopped. ' +
        `manifestHash=${manifestHash}`)
    }

    return {
      url: getPodUrl(podInfo.id),
      manifestHash: podInfo.id,
      expiry: podInfo.expiry
    }
  }

  async function getPod (request: any, h: Hapi.ResponseToolkit) {
    const manifestHash = request.query['manifestHash']
    if (!manifestHash) {
      throw Boom.badData('manifestHash must be specified')
    }

    const manifest = await manifestDatabase.getManifest(manifestHash)
    const podInfo = podDatabase.getPod(manifestHash)
    if (!podInfo) {
      // make sure that the manifest was cleaned up
      await manifestDatabase.deleteManifest(manifestHash)
      throw Boom.serverUnavailable('pod has stopped. ' +
        `manifestHash=${manifestHash}`)
    }

    return {
      url: getPodUrl(podInfo.id),
      manifestHash: podInfo.id,
      expiry: podInfo.expiry,
      manifest
    }
  }

  async function getPodLogs (request: Hapi.Request, h: Hapi.ResponseToolkit) {
    const podId = request.params['id']
    const pod = podDatabase.getPod(podId)

    if (!pod) {
      throw Boom.notFound(`no pod found with this id. id=${podId}`)
    }

    const manifest = await manifestDatabase.getManifest(podId)

    if (!manifest || !manifest.debug) {
      throw Boom.forbidden(`pod manifest does not allow debugging. id=${podId}`)
    }

    const stream = await podManager.getLogStream(podId, request.query['follow'] === 'true')

    return h
      .response(stream)
      .type('text/event-stream')
      // This mime type is set in our server options to disable compression
      .header('Content-Type', 'application/vnd.codius.raw-stream')
      .header('Connection', 'keep-alive')
      .header('Cache-Control', 'no-cache')
  }

  server.route({
    method: 'PUT',
    path: '/pods',
    handler: extendPod,
    options: {
      validate: {
        payload: false
      }
    }
  })

  server.route({
    method: 'GET',
    path: '/pods',
    handler: getPod,
    options: {
      validate: {
        payload: false
      }
    }
  })

  server.route({
    method: 'POST',
    path: '/pods',
    handler: postPod,
    options: {
      validate: {
        payload: Enjoi(PodRequest),
        failAction: async (req, h, err) => {
          log.debug('validation error. error=' + (err && err.message))
          throw Boom.badRequest('Invalid request payload input')
        }
      },
      payload: {
        allow: 'application/json',
        output: 'data'
      }
    }
  })

  server.route({
    method: 'GET',
    path: '/pods/{id}/logs',
    handler: getPodLogs
  })
}
