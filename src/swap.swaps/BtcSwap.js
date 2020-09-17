import debug from 'debug'
import SwapApp, { SwapInterface, constants, util } from 'swap.app'
import BigNumber from 'bignumber.js'


class BtcSwap extends SwapInterface {

  /**
   *
   * @param options
   * @param options.fetchBalance
   * @param options.fetchUnspents
   * @param options.broadcastTx
   * @param options.fetchTxInfo {(tx_hash) => Promise({ confidence, fees })}
   * @param options.estimateFeeValue { ({ inSatoshis, speed, address, txSize }) => Promise(fee_value) }
   */
  constructor(options) {
    super()

    if (typeof options.fetchBalance !== 'function') {
      throw new Error('BtcSwap: "fetchBalance" required')
    }
    if (typeof options.fetchUnspents !== 'function') {
      throw new Error('BtcSwap: "fetchUnspents" required')
    }
    if (typeof options.broadcastTx !== 'function') {
      throw new Error('BtcSwap: "broadcastTx" required')
    }
    if (typeof options.fetchTxInfo !== 'function') {
      // tx_hash => { confidence, fees }
      console.warn(`BtcSwap: "fetchTxInfo" is not a function. You will not be able to use tx-confidence feature`)
    }
    if (typeof options.estimateFeeValue !== 'function') {
      // ({ speed } = {}) => feeRate
      console.warn(`BtcSwap: "estimateFeeValue" is not a function. You will not be able use automatic mempool-based fee`)
    }

    this._swapName      = constants.COINS.btc
    this.fetchBalance   = options.fetchBalance
    this.fetchUnspents  = options.fetchUnspents
    this.broadcastTx    = options.broadcastTx
    this.checkWithdraw  = options.checkWithdraw
    this.feeValue       = options.feeValue || 546
    this.fetchTxInfo    = options.fetchTxInfo || (() => {})
    this.estimateFeeValue = options.estimateFeeValue || (() => 0)
  }

  _initSwap(app) {
    super._initSwap(app)

    this.app = app

    this.network = (
      this.app.isMainNet()
        ? this.app.env.bitcoin.networks.bitcoin
        : this.app.env.bitcoin.networks.testnet
    )
  }

  /**
   *
   * @param {object} options
   * @param {boolean} options.inSatoshis
   * @param {Number} options.size
   * @param {String} options.speed
   * @param {String} options.address
   * @returns {BigNumber}
   * @public
   */
  async getTxFee({ inSatoshis, size, speed = 'fast', address } = {}) {
    const estimatedFeeRaw = await this.estimateFeeValue({
      inSatoshis: true,
      address,
      speed,
      method: 'swap'
      /*, txSize: size */
    })

    const estimatedFee = BigNumber(estimatedFeeRaw)
    this.feeValue = estimatedFee

    return inSatoshis
      ? estimatedFee
      : estimatedFee.dividedBy(1e8).dp(0, BigNumber.ROUND_UP)
  }

  /**
   *
   * @param {array} unspents
   * @param {Number} expectedConfidenceLevel
   * @returns {array}
   * @private
   */
  async filterConfidentUnspents(unspents, expectedConfidenceLevel = 0.95) {
    const feesToConfidence = async (fees, size, address) => {
      const currentFastestFee = await this.getTxFee({ inSatoshis: true, size, speed: 'fast', address })

      return BigNumber(fees).isLessThan(currentFastestFee)
        ? BigNumber(fees).dividedBy(currentFastestFee).toNumber()
        : 1
    }

    const confirmationsToConfidence = confs => confs > 0 ? 1 : 0

    const fetchConfidence = async ({ txid, confirmations }) => {
      const confidenceFromConfirmations = confirmationsToConfidence(confirmations)

      if (BigNumber(confidenceFromConfirmations).isGreaterThanOrEqualTo(expectedConfidenceLevel)) {
        return confidenceFromConfirmations
      }

      try {
        const info = await this.fetchTxInfo(txid)

        const { fees, size, senderAddress } = info

        if (fees) {
          return await feesToConfidence(fees, size, senderAddress)
        }

        throw new Error(`txinfo=${{ confirmations, fees, size, senderAddress }}`)

      } catch (err) {
        console.error(`BtcSwap: Error fetching confidence: using confirmations > 0:`, err.message)
        return confidenceFromConfirmations
      }
    }

    const confidences = await Promise.all(unspents.map(fetchConfidence))

    return unspents.filter((utxo, index) => {
      debug('swap.core:swaps')(`confidence[${index}]:`, confidences[index])
      return BigNumber(confidences[index]).isGreaterThanOrEqualTo(expectedConfidenceLevel)
    })
  }

  /**
   *
   * @param {object} data
   * @param {object} data.script
   * @param {*} data.txRaw
   * @param {string} data.secret
   * @param {number} inputIndex
   * @private
   */
  _signTransaction(data, inputIndex = 0) {
    debug('swap.core:swaps')('signing script input', inputIndex)
    const { script, txRaw, secret } = data

    const scriptData = this.app.env.bitcoin.payments.p2sh({ redeem: { output: script, network: this.network }, network: this.network })

    const hashType      = this.app.env.bitcoin.Transaction.SIGHASH_ALL
    const privKey = this.app.env.bitcoin.ECPair.fromWIF(this.app.services.auth.accounts.btc.getPrivateKey(), this.network)
    const signatureHash = txRaw.hashForSignature(inputIndex, scriptData.redeem.output, hashType);

    const redeemScriptSig = this.app.env.bitcoin.payments.p2sh({ 
      network: this.network, 
      redeem: { 
        network: this.network, 
        output: scriptData.redeem.output, 
        input: this.app.env.bitcoin.script.compile([ 
          this.app.env.bitcoin.script.signature.encode(privKey.sign(signatureHash), hashType),
          this.app.services.auth.accounts.btc.getPublicKeyBuffer(),
          Buffer.from(secret.replace(/^0x/, ''), 'hex'),
        ]) 
      } 
    }).input 

    txRaw.setInputScript(inputIndex, redeemScriptSig);
  }

  /**
   *
   * @param {object} data
   * @param {string} data.secretHash
   * @param {string} data.ownerPublicKey
   * @param {string} data.recipientPublicKey
   * @param {number} data.lockTime
   * @returns {{scriptAddress: *, script: (*|{ignored})}}
   */
  createScript(data, hashName = 'ripemd160') {
    const hashOpcodeName = `OP_${hashName.toUpperCase()}`
    const hashOpcode = this.app.env.bitcoin.opcodes[hashOpcodeName]

    const { secretHash, ownerPublicKey, recipientPublicKey, lockTime } = data

    const script = this.app.env.bitcoin.script.compile([

      hashOpcode,
      Buffer.from(secretHash, 'hex'),
      this.app.env.bitcoin.opcodes.OP_EQUALVERIFY,

      Buffer.from(recipientPublicKey, 'hex'),
      this.app.env.bitcoin.opcodes.OP_EQUAL,
      this.app.env.bitcoin.opcodes.OP_IF,

      Buffer.from(recipientPublicKey, 'hex'),
      this.app.env.bitcoin.opcodes.OP_CHECKSIG,

      this.app.env.bitcoin.opcodes.OP_ELSE,

      this.app.env.bitcoin.script.number.encode(lockTime),
      this.app.env.bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
      this.app.env.bitcoin.opcodes.OP_DROP,
      Buffer.from(ownerPublicKey, 'hex'),
      this.app.env.bitcoin.opcodes.OP_CHECKSIG,

      this.app.env.bitcoin.opcodes.OP_ENDIF,
    ])

    const scriptData = this.app.env.bitcoin.payments.p2sh({ redeem: { output: script, network: this.network }, network: this.network })
    const scriptAddress = scriptData.address

    return {
      scriptAddress,
      script,
    }
  }

  /**
   *
   * @param {object} data
   * @param {string} data.recipientPublicKey
   * @param {number} data.lockTime
   * @param {object} expected
   * @param {number} expected.value
   * @param {number} expected.lockTime
   * @param {string} expected.recipientPublicKey
   * @returns {Promise.<string>}
   */
  async checkScript(data, expected, hashName) {
    const { recipientPublicKey, lockTime } = data
    const { scriptAddress, script } = this.createScript(data, hashName)

    const expectedConfidence = (expected.confidence !== undefined) ? expected.confidence : 0.95
    const unspents      = await this.fetchUnspents(scriptAddress)
    const expectedValue = expected.value.multipliedBy(1e8).integerValue()
    const totalUnspent  = unspents.reduce((summ, { satoshis }) => summ + satoshis, 0)

    const confidentUnspents = await this.filterConfidentUnspents(unspents, expectedConfidence)
    const totalConfidentUnspent = confidentUnspents.reduce((summ, { satoshis }) => summ + satoshis, 0)

    if (expectedValue.isGreaterThan(totalUnspent)) {
      return `Expected script value: ${expectedValue.toNumber()}, got: ${totalUnspent}, address: ${scriptAddress}`
    }
    if (expected.lockTime > lockTime) {
      return `Expected script lockTime: ${expected.lockTime}, got: ${lockTime}, address: ${scriptAddress}`
    }
    if (expected.recipientPublicKey !== recipientPublicKey) {
      return `Expected script recipient publicKey: ${expected.recipientPublicKey}, got: ${recipientPublicKey}`
    }
    if (expectedValue.isGreaterThan(totalConfidentUnspent)) {
      return `Expected script value: ${expectedValue.toString()} with confidence above ${expectedConfidence}, got: ${totalConfidentUnspent}, address: ${scriptAddress}`
    }
  }

  /**
   *
   * @param {object} data
   * @param {object} data.scriptValues
   * @param {BigNumber} data.amount
   * @param {function} handleTransactionHash
   * @param {string} hashName
   * @returns {Promise}
   */
  fundScript(data, handleTransactionHash, hashName) {
    const { scriptValues, amount } = data

    return new Promise(async (resolve, reject) => {
      try {
        const { scriptAddress } = this.createScript(scriptValues, hashName)
        const ownerAddress = this.app.services.auth.accounts.btc.getAddress()

        const tx            = new this.app.env.bitcoin.TransactionBuilder(this.network)
        const unspents      = await this.fetchUnspents(ownerAddress)

        const fundValue     = amount.multipliedBy(1e8).integerValue().toNumber()
        const feeValueBN    = await this.getTxFee({ inSatoshis: true, address: ownerAddress })
        const feeValue      = feeValueBN.integerValue().toNumber()
        const totalUnspent  = unspents.reduce((summ, { satoshis }) => summ + satoshis, 0)
        const skipValue     = totalUnspent - fundValue - feeValue

        if (totalUnspent < feeValue + fundValue) {
          throw new Error(`Total less than fee: ${totalUnspent} < ${feeValue} + ${fundValue}`)
        }

        unspents.forEach(({ txid, vout }) => tx.addInput(txid, vout))
        tx.addOutput(scriptAddress, fundValue)
        tx.addOutput(this.app.services.auth.accounts.btc.getAddress(), skipValue)
        tx.__INPUTS.forEach((input, index) => {
          tx.sign(index, this.app.services.auth.accounts.btc)
        })

        const txRaw = tx.buildIncomplete()

        if (typeof handleTransactionHash === 'function') {
          handleTransactionHash(txRaw.getId())
        }

        try {
          const result = await this.broadcastTx(txRaw.toHex())

          resolve(result)
        }
        catch (err) {
          reject(err)
        }
      }
      catch (err) {
        reject(err)
      }
    })
  }

  /**
   *
   * @param {object|string} data - scriptValues or wallet address
   * @returns {Promise.<void>}
   */
  async getBalance(data, hashName) {
    let address

    if (typeof data === 'string') {
      address = data
    }
    else if (typeof data === 'object') {
      const { scriptAddress } = this.createScript(data, hashName)

      address = scriptAddress
    }
    else {
      throw new Error('Wrong data type')
    }

    const unspents      = await this.fetchUnspents(address)
    const totalUnspent  = unspents && unspents.length && unspents.reduce((summ, { satoshis }) => summ + satoshis, 0) || 0

    return totalUnspent
  }

  /**
   *
   * @param {object} data
   * @param {object} data.scriptValues
   * @param {string} data.secret
   * @param {boolean} isRefund
   * @returns {Promise}
   */
  async getWithdrawRawTransaction(data, isRefund, hashName) {
    const { scriptValues, secret, destinationAddress } = data
    const destAddress = (destinationAddress) ? destinationAddress : this.app.services.auth.accounts.btc.getAddress()

    const { script, scriptAddress } = this.createScript(scriptValues, hashName)

    const tx            = new this.app.env.bitcoin.TransactionBuilder(this.network)
    const unspents      = await this.fetchUnspents(scriptAddress)

    const feeValueBN    = await this.getTxFee({ inSatoshis: true, address: scriptAddress })
    const feeValue      = feeValueBN.integerValue().toNumber()
    const totalUnspent  = unspents.reduce((summ, { satoshis }) => summ + satoshis, 0)

    if (BigNumber(totalUnspent).isLessThan(feeValue)) {
      /* Check - may be withdrawed */
      if (typeof this.checkWithdraw === 'function') {
        const hasWithdraw = await this.checkWithdraw(scriptAddress)
        if (hasWithdraw
          && hasWithdraw.address.toLowerCase() == destAddress.toLowerCase()
        ) {
          // already withdrawed
          return {
            txId: hasWithdraw.txid,
            alreadyWithdrawed: true
          }
        } else {
          throw new Error(`Total less than fee: ${totalUnspent} < ${feeValue}`)
        }
      } else {
        throw new Error(`Total less than fee: ${totalUnspent} < ${feeValue}`)
      }
    }

    if (isRefund) {
      tx.setLockTime(scriptValues.lockTime)
    }

    unspents.forEach(({ txid, vout }) => tx.addInput(txid, vout, 0xfffffffe))
    tx.addOutput(destAddress, totalUnspent - feeValue)

    const txRaw = tx.buildIncomplete()

    tx.__INPUTS.map((_, index) =>
      this._signTransaction({
        script,
        secret,
        txRaw,
      }, index)
    )

    const txHex = txRaw.toHex()
    const txId = txRaw.getId()

    return {
      txHex,
      txId,
    }
    return txRaw
  }

  /**
   *
   * @param {object} data
   * @param {object} data.scriptValues
   * @param {string} data.secret
   * @param {boolean} isRefund
   * @returns {Promise}
   */
  async getWithdrawHexTransaction(data, isRefund) {
    const txRaw = await this.getWithdrawRawTransaction(data, isRefund)

    return txRaw.txHex
  }

  /**
   *
   * @param {object} data
   * @param {object} data.scriptValues
   * @param {string} data.secret
   * @returns {Promise}
   */
  getRefundRawTransaction(data) {
    return this.getWithdrawRawTransaction(data, true)
  }

  /**
   *
   * @param {object} data
   * @param {object} data.scriptValues
   * @param {string} data.secret
   * @returns {Promise}
   */
  async getRefundHexTransaction(data) {
    const txRaw = await this.getRefundRawTransaction(data)

    return txRaw.txHex
  }

  /**
   *
   * @param {object} data
   * @param {object} data.scriptValues
   * @param {string} data.secret
   * @param {function} handleTransactionHash
   * @param {boolean} isRefund
   * @param {string} hashName
   * @returns {Promise}
   */
  withdraw(data, isRefund, hashName) {
    return new Promise(async (resolve, reject) => {
      try {
        const txRaw = await this.getWithdrawRawTransaction(data, isRefund, hashName)

        if (txRaw.alreadyWithdrawed) {
          resolve(txRaw.txId)
          return
        }

        debug('swap.core:swaps')('raw tx withdraw', txRaw.txHex)

        const result = await this.broadcastTx(txRaw.txHex)


        // Wait some delay until transaction can be rejected or broadcast failed
        await util.helpers.waitDelay(10)

        const txSuccess = await this.checkTX(txRaw.txId)

        if (txSuccess) {
          resolve(txRaw.txId)
        } else {
          console.warn('BtcSwap: cant withdraw', 'Generated TX not found')
          reject('TX not found. Try it later. ',txRaw.txId)
        }
      }
      catch (error) {
        console.warn('BtcSwap: cant withdraw', error.message)

        let errorMessage

        if (error.res && /non-final/.test(error.res.text)) {
          errorMessage = 'Try it later'
        } else if (/Total less than fee/.test(error.message)) {
          if (/Total less than fee: 0/.test(error.message)) {
            errorMessage = 'Address is empty'
          } else {
            errorMessage = 'Less than fee'
          }
        } else {
          errorMessage = error
        }

        reject(errorMessage)
      }
    })
  }

  /**
   * 
   * @param {string} txID
   * @returns {Promise}
   */
  async checkTX(txID) {
    const txInfo = await this.fetchTxInfo(txID)
    if (txInfo
      && txInfo.senderAddress
      && txInfo.txid
      && (txInfo.txid.toLowerCase() == txID.toLowerCase())
    ) {
      return true
    }
    return false
  }
  /**
   *
   * @param {object} data
   * @param {object} data.scriptValues
   * @param {string} data.secret
   * @param {function} handleTransactionHash
   * @param {string} hashName
   * @returns {Promise}
   */
  refund(data, hashName) {
    return this.withdraw(data, true, hashName)
  }
}


export default BtcSwap
