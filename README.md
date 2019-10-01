# Codiusless (c8s) Host
> c8s is the hosting component of serverless Codius

[![NPM Package](https://img.shields.io/npm/v/c8s.svg?style=flat)](https://npmjs.org/package/c8s)
[![CircleCI](https://circleci.com/gh/codius/c8s.svg?style=shield)](https://circleci.com/gh/codius/c8s)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![Known Vulnerabilities](https://snyk.io/test/github/codius/c8s/badge.svg?targetFile=package.json)](https://snyk.io/test/github/codius/c8s?targetFile=package.json)
[![Gitter chat](https://badges.gitter.im/codius/services.png)](https://gitter.im/codius/codius-chat)


[Codius](https://codius.org) is an open-source decentralized hosting platform using [Interledger](https://interledger.org). It allows anyone to run software on servers all over the world and pay using any currency. Users package their software inside of [containers](https://www.docker.com/what-container).

**c8s** (this software) is the hosting component. You can run c8s in your [Kubernetes](https://kubernetes.io/) (k8s) cluster and users will pay you via [Web Monetization](https://webmonetization.org/) to run their software. c8s uses [Kata Containers](https://katacontainers.io/) to provide hardware-level isolation between different containers.

## Prerequisites

* CentOS 7 or higher
* A processor with [virtualization support](https://wiki.centos.org/HowTos/KVM#head-6cbcdf8f149ebcf19d53199a30eb053a9fc482db)

## Installation

c8s runs as a [Knative](https://knative.dev/) service in your Kubernetes cluster.

You can use the [c8s installer](https://github.com/wilsonianb/codius-install/tree/c8s) to run a local Kubernetes cluster with c8s.

### Environment Variables

#### CODIUS_PORT
* Type: [Number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number)
* Description: The port that c8s will listen on.
* Default: 3000

#### CODIUS_PUBLIC_URI
* Type: String
* Description: The public URI resolving to this instance of c8s.
* Default: `http://local.codius.org:CODIUS_PORT`

#### CODIUS_K8S_NAMESPACE
* Type: String
* Description: Kubernetes namespace in which to deploy containers
* Default: 'default'

### API Documentation
#### `POST /containers
Create a container that runs a given [Codius Manifest](https://github.com/coilhq/codius-manifest)

##### Request Body:
* Type: Object

| Field Name | Type     | Description              |
|------------|----------|--------------------------|
| manifest   | Object   | An object containing a manifest for your code. The format can be found [here](https://github.com/codius/manifest).|
| private    | Object   | An object containing private variables you want to pass to the host, such as an AWS key. An example can be found as part of the manifest format [here](https://github.com/codius/manifest).|

##### Return Value:
* Type: Object

| Field Name | Type     | Description              |
|------------|----------|--------------------------|
| url        | string   | A URL resolving to the ip address of the container that was just created. It is comprised of the container's manifest hash followed by the hostname of the c8s host.|
| manifestHash | string | The hash of the manifest that was passed to the c8s host.|

## License

Apache-2.0
