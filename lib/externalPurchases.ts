// /transparency 「9. 外部からの実購入 (オンチェーン記録)」の単一情報源。
// 出典 = 受取ウォレット宛の ERC-20 着金 (Base: Alchemy asset transfers・最終集計 2026-10-20)。
// 掟: 自社・関係者ウォレット (FIRST_PARTY_WALLETS) の動作確認決済は載せない (8. 実績の数え方と同じ)。
// 週次更新で末尾に追記する (日付昇順)。金額は表示価格の実払い額。商品名は精算記録 (KV) が要るので載せない。
// 一部はインデクサー (x402scan / x402 List 等) の検証購入の可能性があるが、第三者が実 USDC を払い
// 精算された事実に変わりはないので区別しない (推測を書かない)。

import firstPartyWallets from './firstPartyWallets.json';

export type ExternalPurchase = {
  readonly chain: 'base';
  /** UTC 日付 (ブロックタイムスタンプ)。 */
  readonly date: string;
  /** 表示価格どおりの実払い額 (USDC)。 */
  readonly amount: string;
  readonly asset: 'USDC';
  /** 買い手ウォレット (checksum)。表示は先頭 6 桁 + 末尾 4 桁に短縮する。 */
  readonly payer: string;
  /** settle tx hash (Basescan で検証可能)。 */
  readonly tx: string;
};

/** 自社・関係者ウォレット (小文字)。本体は lib/firstPartyWallets.json (ops script と共有)。ここに載る payer は EXTERNAL_PURCHASES に入れてはいけない (テストで固定)。 */
export const FIRST_PARTY_WALLETS: readonly string[] = firstPartyWallets.map(({ address }) => address);

/** 集計時点 (週次更新で進める)。 */
export const EXTERNAL_PURCHASES_AS_OF = '2026-10-26';

export const EXTERNAL_PURCHASES: readonly ExternalPurchase[] = [
  { chain: 'base', date: '2026-07-19', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0xdea66bfcd77d7c439774b344b64b5750b111b71a3fb23eaee6c24a6947eeed53' },
  { chain: 'base', date: '2026-07-20', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0x5deb902b5a0687731156f8af96589d9d5942d1b90237910c55761b02add50e70' },
  { chain: 'base', date: '2026-07-21', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0x99368e59f491e4e715578a693cefdc2b61235604c506b692bad008e561b17d3e' },
  { chain: 'base', date: '2026-07-22', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0xe19618bd3a4ac7371ffa911276b5459f1bd8adf982dc0ac53ba1c6fa728a74e7' },
  { chain: 'base', date: '2026-07-23', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0xa016f5310bf3d85711ff92de3c9ab68e12f8a9bc1bd902ef301fcb6a5db0d1d6' },
  { chain: 'base', date: '2026-07-25', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0x8205d19b163c45cbad88906eb7fa53175b08934ee181ef0b55d72f355ea53f4c' },
  { chain: 'base', date: '2026-07-26', amount: '0.01', asset: 'USDC', payer: '0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09', tx: '0x6c2a958cb690acbe8d26672916d29ca29e433a887cf62a8b2577f11b71523f1d' },
  { chain: 'base', date: '2026-07-29', amount: '0.01', asset: 'USDC', payer: '0xb83e6924ff53d2a7ef33a3e6906617f9f03f3808', tx: '0x4d9591f58899a88c99ae8576344a59d21dcf08d7e3ec52a12165e401656d6e4f' },
  { chain: 'base', date: '2026-07-30', amount: '0.01', asset: 'USDC', payer: '0xcd513d2e063177caa937d70b4d87603a9a4946a9', tx: '0x3fa561d63e65a9b63629a8062b7e201618e5096f783ace8e7e8e2f70768f5245' },
  { chain: 'base', date: '2026-08-02', amount: '0.01', asset: 'USDC', payer: '0x6292da4f70d194e0a857eb3772185ae4feaedef1', tx: '0x9447e1c521744c65a9368972dfaf318deb3687c8d805b79026742e46529e66f0' },
  { chain: 'base', date: '2026-08-03', amount: '0.01', asset: 'USDC', payer: '0x3d09e5b237a82bea77bdc01fbc2a28fec8cb7e00', tx: '0x2ceb989ae5405b26760e6496cb795d2c35d7859fab92c2dea301d6397dffea69' },
  { chain: 'base', date: '2026-08-17', amount: '0.01', asset: 'USDC', payer: '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', tx: '0xe117702d839f278f02c856586f5fa5445d4cb301e63799c2eaee085baaf9d38d' },
  { chain: 'base', date: '2026-08-18', amount: '0.01', asset: 'USDC', payer: '0x843b544bf5f0aa6cbf13e94563874878c98cc4a7', tx: '0x54581417c874f14a52cb8cd15366dd8fe6722c555859e59a38f4da8d5da796d0' },
  { chain: 'base', date: '2026-08-23', amount: '0.01', asset: 'USDC', payer: '0xc59e74ed6386b2a12d892fff2509a6965a0498dc', tx: '0xfd7b1d145d187ea1e9232e057da3d1000ecfa38171f5392c4f9b0c9f40cf68ac' },
  { chain: 'base', date: '2026-08-26', amount: '0.01', asset: 'USDC', payer: '0xc59e74ed6386b2a12d892fff2509a6965a0498dc', tx: '0xb931b201c088ebc7fafaa56b8f4c16d5c203f71e21db183ce5b76c7fa331e001' },
  { chain: 'base', date: '2026-08-26', amount: '0.006', asset: 'USDC', payer: '0xc59e74ed6386b2a12d892fff2509a6965a0498dc', tx: '0x3e1648447a886ff5a9de1cc5069374bc91c31a1d07dfc57e25ecc9eca32c073a' },
  { chain: 'base', date: '2026-08-30', amount: '0.01', asset: 'USDC', payer: '0xc533bf5268a2f64adde58dce380651f70aa92d7a', tx: '0xf479892bf4877038448afaf0230c7fa345fefb04dbe484c29c90d80fc37fefd3' },
  { chain: 'base', date: '2026-09-04', amount: '0.01', asset: 'USDC', payer: '0x6777e11fb0a7917b8110b7dab9188aa3f6d23986', tx: '0x30fd7ea5e743e820bf73fdf32543e2865162e498f78f1460c3ae97d4f189a8ba' },
  { chain: 'base', date: '2026-09-04', amount: '0.006', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0xc99eefefbe9f46fbcb5ebc8ea1bf371675c345cbfc08063110231d4aae92cf34' },
  { chain: 'base', date: '2026-09-08', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0x853992261cdb710da57510f7afe0d391d8f54d9e09c5faab41fbc24bbee0e526' },
  { chain: 'base', date: '2026-09-12', amount: '0.001', asset: 'USDC', payer: '0x902dcf34e53695bdea2ffb354b1a2e58bd598256', tx: '0x3e77f30ec69ed13161e81fd5691eab5d95a8e177b786eb945b87cb274d4b1aac' },
  { chain: 'base', date: '2026-09-14', amount: '0.01', asset: 'USDC', payer: '0xe3badbd4f38214b9eae528a1a5398f6678f63fb3', tx: '0x735592436cec0230f4834c5f686b64b760bb28c9551075601a20344b05cedf9b' },
  { chain: 'base', date: '2026-09-14', amount: '0.001', asset: 'USDC', payer: '0xe3badbd4f38214b9eae528a1a5398f6678f63fb3', tx: '0xa42f6a9f9b6280e743210f903c6f5bb25c8d9cf60d78187c4822473db9a79c95' },
  { chain: 'base', date: '2026-09-17', amount: '0.001', asset: 'USDC', payer: '0x7dd81398fac7de0bf843bfd874cbea68face17d2', tx: '0xb8f649f27b88c736971e02c43189f2dd85fcfeace648af697f0b677657b9adc3' },
  { chain: 'base', date: '2026-09-27', amount: '0.01', asset: 'USDC', payer: '0xec2abd3eda89bed90124736e317e847d5fb6d034', tx: '0x6b33f40f51725debeb914a74cdcd0cede4b1a930016fe6df6f95f991aa03a4f6' },
  { chain: 'base', date: '2026-09-28', amount: '0.001', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0xd8508a7abe83c93f1e09eeea3a5d2327d67afa27089df20f5c100a6ad32cdb7f' },
  { chain: 'base', date: '2026-09-28', amount: '0.006', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0xe3dd52f3cc24b70c0c754568a798b5a4b1a46bc8034db03d99982c27c4d11e49' },
  { chain: 'base', date: '2026-09-28', amount: '0.01', asset: 'USDC', payer: '0xec2abd3eda89bed90124736e317e847d5fb6d034', tx: '0x69a160d1a9fcf3c9ef6a80c79b674dfa5a6a8599e1855137ecc6c116012470b4' },
  { chain: 'base', date: '2026-09-28', amount: '0.01', asset: 'USDC', payer: '0xec2abd3eda89bed90124736e317e847d5fb6d034', tx: '0x471cd681c9d623f6d480ebe0c6cea559efdee358faf5394733fc6df7b434f7e0' },
  { chain: 'base', date: '2026-09-29', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0x5a1dc7fe2feae80b738a5599fe2863bfe933aa1612dbadd0854a0e8a56206e7f' },
  { chain: 'base', date: '2026-09-29', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0xd18f500c421064a9c1df7d06ee2f9e4faee3d5ad5c53370d38d83e91a9f84245' },
  { chain: 'base', date: '2026-09-30', amount: '0.01', asset: 'USDC', payer: '0xec2abd3eda89bed90124736e317e847d5fb6d034', tx: '0xa50068349f4beae13b7ec52213b9bac1a2b8257f7cef4036b84565445a0e64d9' },
  { chain: 'base', date: '2026-10-02', amount: '0.01', asset: 'USDC', payer: '0x4c29ec4f680ca88d0019edbfe3a8ff5c80499494', tx: '0xf4b2f7091d992d8e09053508873cc4bcdb92249711b235ea09d8cbb5023a460d' },
  { chain: 'base', date: '2026-10-03', amount: '0.01', asset: 'USDC', payer: '0xec2abd3eda89bed90124736e317e847d5fb6d034', tx: '0xc5b4c45e3348db51fabe6721e19bc78bb87f78bf6480758a686422b92a013673' },
  { chain: 'base', date: '2026-10-04', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0xc32aff70687abd99c1748837a6d0a634d118c2426cfcd2187ce658a461886745' },
  { chain: 'base', date: '2026-10-04', amount: '0.001', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0x4106356300ab1932d16e2f65360d439df97b0a4b8ad4f64f048f8a747d11a11a' },
  { chain: 'base', date: '2026-10-05', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0xf14dd68d5fe6c1c79f947a21b9c52218b5f0a9ef9f8d0cdd8db66923a968f61c' },
  { chain: 'base', date: '2026-10-05', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0x1a91a8a03c943b064a721e2fe7490cd65575ec33f8a99960e63e6e955a9f6285' },
  { chain: 'base', date: '2026-10-06', amount: '0.001', asset: 'USDC', payer: '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', tx: '0xe9f8f0dd5b988ead6d2103500907b16df7ee7c0ed81d79e297e1cfadfc8268e9' },
  { chain: 'base', date: '2026-10-08', amount: '0.01', asset: 'USDC', payer: '0x6a0b784cf4e3f79e0bca889e35a1b3aa1dc24518', tx: '0x06bb33601e7fb998a787f0ccdb70fd2f9ec89003f2637f56f83f9b012e932e25' },
  { chain: 'base', date: '2026-10-08', amount: '0.01', asset: 'USDC', payer: '0x6a0b784cf4e3f79e0bca889e35a1b3aa1dc24518', tx: '0xc68d704a4ef86ebe77eff8981e80d01a1c98f9eac5cea4cc419fae44ee168def' },
  { chain: 'base', date: '2026-10-08', amount: '0.001', asset: 'USDC', payer: '0x6a0b784cf4e3f79e0bca889e35a1b3aa1dc24518', tx: '0xb9ceff40a5be6cca051a9a74ce82d5487c060504e23723c1d0528aab148cf2c6' },
  { chain: 'base', date: '2026-10-08', amount: '0.01', asset: 'USDC', payer: '0x6a0b784cf4e3f79e0bca889e35a1b3aa1dc24518', tx: '0xaf8adbe6759d9ba69dd8f86411b9a68bd2719d78fe516167b5c372121a99eab8' },
  { chain: 'base', date: '2026-10-08', amount: '0.001', asset: 'USDC', payer: '0x0ffab3cea2221070abfb6deb76206946d5e0daaf', tx: '0xe8dd94e633714250788bf8bc82a7c40cf3af319e94b0bf49834718924330b9d7' },
  { chain: 'base', date: '2026-10-09', amount: '0.01', asset: 'USDC', payer: '0xec2abd3eda89bed90124736e317e847d5fb6d034', tx: '0xba4d27edd6d4ecd0c8d664083c13698a385173c7ea04cd8d26fb9a89493f48e7' },
  { chain: 'base', date: '2026-10-09', amount: '0.006', asset: 'USDC', payer: '0xec2abd3eda89bed90124736e317e847d5fb6d034', tx: '0xe70bba8a7c92f8ce1c692d8f5ffd8b597b4e3d2be9d50724813d5a0fd76a4ce6' },
  { chain: 'base', date: '2026-10-09', amount: '0.001', asset: 'USDC', payer: '0xec2abd3eda89bed90124736e317e847d5fb6d034', tx: '0xb77bd78a953b09c25725db651fcd178c8bdea5f9e5af533c849379c9b5a3fdce' },
  { chain: 'base', date: '2026-10-10', amount: '0.001', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0x41c58c9b8013387ae2d77ee5bf35f48dee146ec33bfd74e2aab093d176e79e10' },
  { chain: 'base', date: '2026-10-11', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0xe163ea32f324cc70036661d3130963cc30c893826e1877ac05430f3e3fd868b5' },
  { chain: 'base', date: '2026-10-11', amount: '0.01', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0x8475c1fa095f1954d50535ec802199080bd274c36736767e80f2936ba3b22fed' },
  { chain: 'base', date: '2026-10-12', amount: '0.001', asset: 'USDC', payer: '0x9d42eba8868cfd38a50ba615ee0cf903f1bbece9', tx: '0x53909fbe44ba748be2e7b3623ef8df07e0449baaab126b9d3f1cc3cb7770854d' },
  { chain: 'base', date: '2026-10-14', amount: '0.001', asset: 'USDC', payer: '0xa1d1c0cf717402ff3651aa4873ccf96410b01978', tx: '0x1e8f652c2b954678b4063c1dcec01bb0f5ce949f7842d75b9bcabcc5aceac204' },
  { chain: 'base', date: '2026-10-16', amount: '0.001', asset: 'USDC', payer: '0x7e6abf81352b2115fd939b5dd2c568993339dc60', tx: '0x187c3385cfc7fec266c0a764c65388599589e6df37d3f9cecabf3021b9794488' },
  { chain: 'base', date: '2026-10-17', amount: '0.01', asset: 'USDC', payer: '0xcc09c1131c53013f386b0ceaf9319d94f8c540d8', tx: '0x1ef5608dee4939df123b4ce3afc10c0f9064530f380f63d37613d8a4d9228143' },
  { chain: 'base', date: '2026-10-19', amount: '0.001', asset: 'USDC', payer: '0x9d42eba8868cfd38a50ba615ee0cf903f1bbece9', tx: '0x4a7f0d794e49bdd5a46a8796904be6f5a0e91215ca33fe34b4b48d32ff96b651' },
  { chain: 'base', date: '2026-10-19', amount: '0.006', asset: 'USDC', payer: '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', tx: '0x72d504ddb73d25c4ba13b24beed7cb2dc0d6c4becc57a1aeb3f604d7cda804f8' },
  { chain: 'base', date: '2026-10-19', amount: '0.01', asset: 'USDC', payer: '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', tx: '0x8e50fcd2f51f607f6d0ca71c634c9ddd2f06b98aa5dffcd8da7426c0e3648b9d' },
  { chain: 'base', date: '2026-10-19', amount: '0.01', asset: 'USDC', payer: '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', tx: '0x9ba4f1e1219695f9c330ad8fc6504f17e02f50ad596d29fe0b733f400657fbfc' },
  { chain: 'base', date: '2026-10-19', amount: '0.01', asset: 'USDC', payer: '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', tx: '0xe2ba67c4c3a668b1053c7903614222dfc83b2efc5ae3a99ab26af44fead81777' },
  { chain: 'base', date: '2026-10-19', amount: '0.01', asset: 'USDC', payer: '0xcb4cf336349504e167c26d5c8b9238e12d70bbb8', tx: '0x854488bbc2c19a2dc1d7d1d5388d85348d2f3670ddb14fd9476e4b4a36230fd6' },
  { chain: 'base', date: '2026-10-20', amount: '0.02', asset: 'USDC', payer: '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670', tx: '0x331f6cbb608f4568d570feb4539e21dff2a382339080e4762d9d36f142b5a093' },
  { chain: 'base', date: '2026-10-21', amount: '0.01', asset: 'USDC', payer: '0x171d8021b98c53dcbb3c9c30cbbbeb1b01850fca', tx: '0x429df74c72f6353581039003df4360272c3da68b3e1d0de3142ab914db72ca8e' },
  { chain: 'base', date: '2026-10-22', amount: '0.001', asset: 'USDC', payer: '0x7722dfae6bbed2fd02dc07455c2f5bf14be25e4a', tx: '0xc9cd14c0dc09c3aa532db43ad957fa610abe391018dad3c6e740d42bb546a52a' },
  { chain: 'base', date: '2026-10-22', amount: '0.001', asset: 'USDC', payer: '0x3ed93a7b87832f04a91137cacb273d39295e430e', tx: '0xc1290bed788e144e429c455cf0d4f52142fd3662c2b0b5fc94f07aa5c295e48f' },
  { chain: 'base', date: '2026-10-23', amount: '0.006', asset: 'USDC', payer: '0x7722dfae6bbed2fd02dc07455c2f5bf14be25e4a', tx: '0x7b6a4e4591ac6458fa68e692f856d23120d051177ec1687d7b47ff147bdb79f5' },
  { chain: 'base', date: '2026-10-25', amount: '0.001', asset: 'USDC', payer: '0x2465a48f1e44ef60a986257e0b7c6f90e0a8a1b1', tx: '0x7fd88f4faca6ad7ec872a5db333e4edd4f3213e5f091c9b78862ae242b7f395f' },
  { chain: 'base', date: '2026-10-26', amount: '0.02', asset: 'USDC', payer: '0x7722dfae6bbed2fd02dc07455c2f5bf14be25e4a', tx: '0x4ac04f06c5aa5d6498f252b8613d48cdb648775c08a44f73c95e276f75cab697' },
  { chain: 'base', date: '2026-10-26', amount: '0.001', asset: 'USDC', payer: '0x9d42eba8868cfd38a50ba615ee0cf903f1bbece9', tx: '0xf79992f0b65552d509311880f0e13bdb8fa6111f905961c3b39cf95b4b1f630a' },
  { chain: 'base', date: '2026-10-26', amount: '0.001', asset: 'USDC', payer: '0xb83be19a6f16bb7643ecd015afbe14d8a35375cc', tx: '0x9fad2f739f2b2634572ac0e61ec05d5dc162a5169cdf43ed7a4e18ebcd165e37' },
];

export function externalPurchaseSummary(rows: readonly ExternalPurchase[] = EXTERNAL_PURCHASES): {
  buyers: number; settlements: number; first: string | null; last: string | null;
} {
  const buyers = new Set(rows.map((r) => r.payer.toLowerCase())).size;
  const dates = rows.map((r) => r.date).sort();
  return { buyers, settlements: rows.length, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null };
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function basescanTxUrl(tx: string): string {
  return `https://basescan.org/tx/${tx}`;
}
