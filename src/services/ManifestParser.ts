import { KnativeServiceSpec } from '../schemas/KnativeServiceSpec'
import { ContainerSpec } from '../schemas/ContainerSpec'
import { Injector } from 'reduct'
import Config from './Config'
import ManifestHash from './ManifestHash'
import { createHash } from 'crypto'
import Boom from '@hapi/boom'
const canonicalJson = require('canonical-json')

export interface ManifestOptions {
  deps: Injector
  manifest: object
  privateManifest: object
}

export interface Env {
  name: string,
  value: string
}

export class Manifest {
  private config: Config
  private hash: string
  private manifest: object
  private privateManifest: object
  private readonly MACHINE_SPECS = {
    small: {
      cpu: '1000m',
      memory: '512Mi'
    }
  }

  constructor (opts: ManifestOptions) {
    this.manifest = opts.manifest
    this.config = opts.deps(Config)
    this.hash = opts.deps(ManifestHash).hashManifest(this.manifest)
    this.privateManifest = opts.privateManifest
  }

  toKnativeServiceSpec (): KnativeServiceSpec {
    return {
      apiVersion: 'serving.knative.dev/v1alpha1',
      kind: 'Service',
      metadata: {
        name: `proxy-${this.hash}`,
        namespace: this.config.k8sNamespace,
        labels: {
          'serving.knative.dev/visibility': 'cluster-local'
        },
        annotations: {
          manifestHash: this.hash
        }
      },
      spec: {
        template: {
          metadata: {
            annotations: {
              'io.kubernetes.cri.untrusted-workload': 'true'
            }
          },
          spec: {
            serviceAccountName: this.config.k8sServiceAccount,
            containers: this.manifest['containers']
              .map(this.processContainer.bind(this))
          }
        }
      }
    }
  }

  machineToResource (machine: keyof typeof Manifest.prototype.MACHINE_SPECS) {
    return this.MACHINE_SPECS[machine] || this.MACHINE_SPECS['small']
  }

  processContainer (container: object): ContainerSpec {
    return {
      name: `${container['id']}`,
      image: container['image'],
      command: container['command'],
      workingDir: container['workdir'],
      resources: {
        limits: this.machineToResource(this.manifest['machine'])
      },
      env: this.processEnv(container['environment']),
      ports: this.manifest['port'] ? [{
        containerPort: Number(this.manifest['port'])
      }] : undefined
    }
  }

  processEnv (environment: object): Array<Env> {
    const hostEnv = [{
      name: 'CODIUS',
      value: 'true'
    }, {
      name: 'CODIUS_HOST',
      // TODO: if this URI resolves to 127.0.0.1 it won't be accesible to
      // the contract from inside of hyper
      value: this.config.publicUri
    }, {
      name: 'CODIUS_MANIFEST_HASH',
      value: this.hash
    }, {
      name: 'CODIUS_MANIFEST',
      value: JSON.stringify(this.manifest)
    }]

    if (!environment) return hostEnv

    const manifestEnv = Object.keys(environment).map((key) => {
      if (key.startsWith('CODIUS')) {
        throw Boom.badData('environment variables starting in ' +
          '"CODIUS" are reserved. ' +
          `var=${key}`)
      }

      return {
        name: key,
        value: this.processValue(environment[key])
      }
    })

    return ([] as Array<Env>).concat(hostEnv, manifestEnv)
  }

  processValue (value: string): string {
    if (!value.startsWith('$')) return value

    const varName = value.substring(1)
    const varSpec = this.manifest['vars'] && this.manifest['vars'][varName]
    const privateVarSpec = this.privateManifest['vars'] &&
      this.privateManifest['vars'][varName]

    if (!varSpec) {
      throw Boom.badData('could not interpolate var. ' +
        `var=${value} ` +
        `manifest.vars=${JSON.stringify(this.manifest['vars'])}`)
    }

    if (!varSpec.encoding) {
      return varSpec.value
    }

    if (varSpec.encoding === 'private:sha256') {
      if (!privateVarSpec) {
        throw Boom.badData('could not interpolate private var. ' +
          `var=${value} ` +
          `manifest.vars=${JSON.stringify(this.manifest['vars'])}`)
      }

      const hashPrivateVar = createHash('sha256')
        .update(canonicalJson(privateVarSpec))
        .digest('hex')

      if (hashPrivateVar !== varSpec.value) {
        throw Boom.badData('private var does not match hash. ' +
          `var=${value} ` +
          `encoding=${varSpec.encoding} ` +
          `public-hash=${varSpec.value} ` +
          `hashed-value=${hashPrivateVar}`)
      }

      return privateVarSpec.value
    }

    throw Boom.badData('unknown var encoding. var=' + JSON.stringify(varSpec))
  }
}

export default class ManifestParser {
  private deps: Injector

  constructor (deps: Injector) {
    this.deps = deps
  }

  manifestToKnativeServiceSpec (manifest: object, privateManifest: object): KnativeServiceSpec {
    return new Manifest({
      deps: this.deps,
      manifest,
      privateManifest
    }).toKnativeServiceSpec()
  }
}
