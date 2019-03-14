import { Client1_13 } from 'kubernetes-client'
const Request = require('kubernetes-client/backends/request')
import { PodSpec } from '../schemas/PodSpec'
import * as Boom from 'boom'
import Config from './Config'
import { Injector } from 'reduct'
import { IncomingMessage } from 'http'

import { create as createLogger } from '../common/log'
const log = createLogger('KubernetesClient')

export interface PodInfoResponse {
  kind: string
  apiVersion: string
  metadata: {
    name: string,
    namespace: string,
    selfLink: string,
    uid: string,
    resourceVersion: string,
    creationTimestamp: string
  },
  spec: {
    containers: {
      name: string,
      image: string,
      env: {
        name: string
        value: string
      }[],
      resources: {
        limits: {
          cpu: string,
          memory: string
        },
        requests: {
          cpu: string,
          memory: string
        }
      },
      terminationMessagePath: string,
      terminationMessagePolicy: string,
      imagePullPolicy: string
    }[],
    restartPolicy: string,
    terminationGracePeriodSeconds: string,
    dnsPolicy: string,
    serviceAccountName: string,
    serviceAccount: string,
    automountServiceAccountToken: boolean,
    nodeName: string,
    securityContext: object,
    schedulerName: string,
    tolerations: {
      key: string,
      operator: string,
      effect: string,
      tolerationSeconds: number
    }[],
    priority: number,
    runtimeClassName: string,
    enableServiceLinks: boolean
  },
  status: {
    phase: string,
    conditions: {
      type: string,
      status: string,
      lastProbeTime: string,
      lastTransitionTime: string
    }[],
    hostIP: string,
    podIP: string,
    startTime: string,
    containerStatuses: {
      name: string,
      state: {
        running: {
          startedAt: string
        }
      },
      lastState: {},
      ready: boolean,
      restartCount: number,
      image: string,
      imageID: string,
      containerID: string
    }[],
    qosClass: string
  }
}

export default class KubernetesClient {
  private client: any
  private config: Config

  constructor (deps: Injector) {
    this.config = deps(Config)

    const devConfig = {
      auth: {
        bearer: 'token'
      },
      ca: 'ca',
      namespace: 'namespace',
      url: 'https://host:443'
    }

    const k8sConfig = this.config.devMode ? devConfig : Request.config.getInCluster()
    this.client = new Client1_13({ backend: new Request(k8sConfig) })
  }

  async getPodInfo (podId: string): Promise<PodInfoResponse> {
    log.debug(`fetching pod info. id=${podId}`)
    const response = await this.client.api.v1.namespaces(this.config.k8sNamespace).pods(podId).get()
    return response.body
  }

  async getPodIP (hash: string): Promise<string> {
    const info = await this.getPodInfo(hash)
    return info.status.podIP
  }

  async getPodList (): Promise<Array<string>> {
    const res = await this.client.api.v1.namespaces(this.config.k8sNamespace).pods.get({
      qs: {
        includeUninitialized: true
      }
    })

    const pods = res.body.items.reduce((acc: Array<string>, pod: PodInfoResponse) => {
      if (pod.status.phase === 'Running') {
        return [...acc, pod.metadata.name]
      }
      return acc
    }, [])

    log.debug(`running pod list=${pods}`)
    return pods
  }

  async deletePod (podId: string): Promise<void> {
    log.info('deleting pod. id=%s', podId)
    try {
      await this.client.api.v1.namespaces(this.config.k8sNamespace).pods(podId).delete()
    } catch (e) {
      throw Boom.serverUnavailable('Could not delete pod: error=' + e.message)
    }
  }

  // rename create
  async runPod (podSpec: PodSpec): Promise<void> {
    log.info('creating pod. id=%s', podSpec.metadata.name)
    try {
      await this.client.api.v1.namespaces(this.config.k8sNamespace).pods.post({ body: podSpec })
      await new Promise(async (resolve, reject) => {
        const stream = await this.client.api.v1.watch.namespaces(this.config.k8sNamespace).pods(podSpec.metadata.name).getObjectStream()

        const timer = setTimeout(() => {
          reject(new Error('Timed out before pod reached Ready state'))
        }, 60000)

        stream.on('data', (pod: any) => {
          if (pod.object && pod.object.status.phase === 'Running') {
            clearTimeout(timer)
            resolve()
          }
        })
      })
    } catch (e) {
      throw Boom.serverUnavailable('Could not create pod: error=' + e.message)
    }
  }

  getLog (podId: string, containerId: string, follow: boolean = false): Promise<IncomingMessage> {
    log.info('attaching to pod. id=%s', podId)
    try {
      return this.client.api.v1.namespaces(this.config.k8sNamespace).pods(podId).log.getByteStream({
        qs: {
          container: containerId,
          follow: true
        }
      })
    } catch (e) {
      throw Boom.serverUnavailable('failed to attach to pod: error=' + e.message)
    }
  }
}
