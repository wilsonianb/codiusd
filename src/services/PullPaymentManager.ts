import { IlpPullManager, RecurringPull } from 'ilp-pull-manager'
import { EventEmitter } from 'events'
import { Injector } from 'reduct'

export default class PullPaymentManager extends EventEmitter {
  private pullManager: IlpPullManager

  constructor (deps: Injector) {
    super()
    this.pullManager = new IlpPullManager()

    this.pullManager.on('paid', this.emitPayment.bind(this))
    this.pullManager.on('failed', this.emitPayment.bind(this))
  }

  emitPayment (manifestHash: string, totalReceived: string) {
    this.emit('pullPayment', manifestHash, this.pullManager.getRecurringPull(manifestHash), totalReceived)
  }

  public async startRecurringPull (manifestHash: string, recurringPull: RecurringPull): Promise<boolean> {
    return this.pullManager.startRecurringPull(manifestHash, recurringPull)
  }

  public stopRecurringPull (manifestHash: string): void {
    return this.pullManager.stopRecurringPull(manifestHash)
  }
}
