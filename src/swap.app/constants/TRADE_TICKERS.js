import { NATIVE, ETH_TOKENS } from './COINS'

export default [
  'ETH-BTC',
  'ETH-SUM',
  'ETH-GHOST',

  ...Object.values(ETH_TOKENS).map(token => `${token}-BTC`),
  // ...Object.values(ETH_TOKENS).map(token => `${token}-USDT`),
]
