export const INSTACART_STORES = [
  { label: 'Walmart', slug: 'walmart' },
  { label: 'Loblaws', slug: 'loblaw' },
  { label: 'No Frills', slug: 'no-frills' },
  { label: 'Metro', slug: 'metro' },
  { label: 'Food Basics', slug: 'food-basics' },
  { label: 'FreshCo', slug: 'freshco' },
  { label: 'Sobeys', slug: 'sobeys' },
  { label: 'Costco', slug: 'costco' },
  { label: 'Adonis', slug: 'adonis' },
  { label: 'T&T', slug: 't-and-t-supermarket' },
  { label: 'Farm Boy', slug: 'farm-boy' },
  { label: 'IGA', slug: 'iga' },
]

export function storeLabel(slug: string): string {
  return INSTACART_STORES.find(s => s.slug === slug)?.label ?? slug
}
