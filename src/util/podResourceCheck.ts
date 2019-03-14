import { PodSpec } from '../schemas/PodSpec'
import { ContainerSpec } from '../schemas/ContainerSpec'

export function checkMemory (pod: PodSpec): number {
  return pod.spec.containers.reduce((acc: number, container: ContainerSpec): number => {
    // Strip Mi suffix
    return acc + Number(container.resources.limits.memory.slice(0, -2))
  }, 0)
}

export function checkCPU (pod: PodSpec): number {
  return pod.spec.containers.reduce((acc: number, container: ContainerSpec): number => {
    // Strip m suffix
    return acc + Number(container.resources.limits.cpu.slice(0, -1))
  }, 0)
}
