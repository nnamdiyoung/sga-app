export type GroceryItem = {
  id: string
  user_id: string
  name: string
  quantity: string
  notes: string
  added_at: string
  cleared: boolean
}

export type Schedule = {
  id: string
  user_id: string
  days: number[]
  time: string
  reminder_enabled: boolean
  reminder_hours_before: number
  active: boolean
}

export type Cart = {
  id: string
  user_id: string
  created_at: string
  status: 'pending' | 'reviewed' | 'checked_out'
  total: number
  platform: string
  walmart_added: boolean
  items: CartItem[]
}

export type CartItem = {
  id: string
  cart_id: string
  grocery_item_name: string
  product_name: string
  price: number
  image_url: string
  product_url: string
  store: string
  swapped: boolean
  quantity?: string
}

export type UserProfile = {
  id: string
  user_id: string
  budget: number
  dietary: string[]
  allergies: string[]
  brands: string[]
  walmart_session: string
  github_token?: string
}
