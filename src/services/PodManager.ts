// import axios from 'axios'
import * as Boom from 'boom'
import { Injector } from 'reduct'
import { PodSpec } from '../schemas/PodSpec'
import KubernetesClient from './KubernetesClient'
import PodDatabase from './PodDatabase'
import ManifestDatabase from './ManifestDatabase'
import { checkMemory } from '../util/podResourceCheck'
import { Transform, PassThrough } from 'stream'
import * as multi from 'multi-read-stream'
import { create as createLogger } from '../common/log'
const log = createLogger('PodManager')

const DEFAULT_INTERVAL = 5000

export default class PodManager {
  private pods: PodDatabase
  private manifests: ManifestDatabase
  private kubernetesClient: KubernetesClient

  constructor (deps: Injector) {
    this.pods = deps(PodDatabase)
    this.manifests = deps(ManifestDatabase)
    this.kubernetesClient = deps(KubernetesClient)
  }

  public checkPodMem (memory: number | void): number {
    if (memory) {
      return memory
    }
    return 0
  }

  start () {
    this.run()
      .catch(err => log.error(err))
  }

  async run () {
    // log.debug('monitoring for expired images')

    const expired = this.pods.getExpiredPods()
    if (expired.length) {
      log.debug('got expired pods. pods=' + JSON.stringify(expired))
    }

    await Promise.all(expired.map(async pod => {
      log.debug('cleaning up pod. id=' + pod)
      try {
        await this.kubernetesClient.deletePod(pod)
        await this.manifests.deleteManifest(pod)
      } catch (e) {
        log.error('error cleaning up pod. ' +
          `id=${pod} ` +
          `error=${e.message}`)
      }

      await this.pods.deletePod(pod)
    }))

    setTimeout(this.run.bind(this), DEFAULT_INTERVAL)
  }

  public getMemoryUsed () {
    const runningPods = this.pods.getRunningPods()
    let memory = 0
    for (let i = 0; i < runningPods.length; i++) {
      let pod = this.pods.getPod(runningPods[i])
      if (pod) {
        memory += this.checkPodMem(pod.memory)
      }
    }
    return memory
  }

  async startPod (podSpec: PodSpec, duration: string, port?: string) {
    if (this.pods.getPod(podSpec.metadata.name)) {
      const isRunning = await this.kubernetesClient.getPodInfo(podSpec.metadata.name)
        .then(info => !!info && info.status.phase === 'Running')
        .catch(() => false)
      if (isRunning) {
        await this.pods.addDurationToPod(podSpec.metadata.name, duration)
        return
      }
    }

    try {
      await this.pods.addPod({
        id: podSpec.metadata.name,
        running: true,
        duration,
        memory: checkMemory(podSpec)
      })

      // TODO: validate regex on port arg incoming
      if (port && Number(port) > 0) {
        await this.pods.setPodPort(podSpec.metadata.name, port)
      }
      await this.kubernetesClient.runPod(podSpec)

      const ip = await this.kubernetesClient.getPodIP(podSpec.metadata.name)
      await this.pods.setPodIP(podSpec.metadata.name, ip)

    } catch (err) {
      log.error(`run pod failed, error=${err.message}`)
      throw Boom.badImplementation('run pod failed')
    } finally {
      await this.verifyRunningPods()
    }

  }

  async getLogStream (podId: string, follow: boolean = false) {
    const { spec: { containers } } = await this.kubernetesClient.getPodInfo(podId)

    const streams = await Promise.all(containers.map(async container => {
      const stream = await this.kubernetesClient.getLog(podId, container.name, follow)
      const transform = new Transform({
        transform (chunk: Buffer, encoding: string, callback: Function) {
          const containerName = container.name.substring(container.name.indexOf('_') + 1)  // why the substring?
          const logLine = `${containerName} ${chunk.toString()}`
          callback(null, logLine)
        }
      })
      stream.pipe(transform)
      return transform
    }))

    if (follow) {
      const pingStream = new PassThrough()
      let pingInterval = setInterval(() => pingStream.push('ping\n'), 1000)
      pingStream.on('end', () => clearInterval(pingInterval))

      streams.push(pingStream)
    }

    return multi(streams)
  }

  private async verifyRunningPods () {
    const dbPods = this.pods.getRunningPods()
    log.debug(`dbPods=${dbPods}`)
    const runningPodsSet = new Set(await this.kubernetesClient.getPodList())
    const podsToDelete = dbPods.filter(pod => !runningPodsSet.has(pod))
    log.debug(`delete pods=${podsToDelete}`)
    this.pods.deletePods(podsToDelete)
  }
}
