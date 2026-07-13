export const JPYC_SHOPS_SEARCH_RESOURCE = {
  path: '/api/paid/jpyc-shops/search',
  priceJpyc: '2',
  category: 'data',
  description:
    'Search opt-in OpenPay shops with live JPYC ordering availability.',
  outputSchema: {
    input: { type: 'http', method: 'GET', discoverable: true },
    output: {
      type: 'object',
      properties: {
        schemaVersion: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              handle: { type: 'string' },
              name: { type: 'string' },
              mode: { type: 'string', enum: ['storefront', 'preorder'] },
              acceptingNow: { type: ['boolean', 'null'] },
              pageUrl: { type: 'string' },
              menuUrl: { type: 'string' },
            },
            required: [
              'handle',
              'name',
              'mode',
              'acceptingNow',
              'pageUrl',
              'menuUrl',
            ],
          },
        },
        total: { type: 'integer' },
      },
      required: ['schemaVersion', 'items', 'total'],
    },
  },
} as const;
