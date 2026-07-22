import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, SafeAreaView, Image, Linking, RefreshControl, Animated
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font, shadow } from '../../lib/theme'
import type { Cart, CartItem } from '../../lib/types'

// ---------------------------------------------------------------------------
// Amazon shared cart URL builder
// ---------------------------------------------------------------------------
function buildAmazonCartUrl(items: CartItem[]): string {
  const params: string[] = []
  let idx = 1
  for (const item of items) {
    const src = item.asin || item.product_url || ''
    const match = src.match(/\/dp\/([A-Z0-9]{10})|^([A-Z0-9]{10})$/)
    const asin = match?.[1] || match?.[2]
    if (asin) {
      params.push(`ASIN.${idx}=${asin}`, `Quantity.${idx}=1`)
      idx++
    }
  }
  if (params.length === 0) return 'https://www.amazon.ca'
  return `https://www.amazon.ca/gp/aws/cart/add.html?${params.join('&')}`
}

function hasAmazonASINs(items: CartItem[]): boolean {
  return items.some(item => {
    const src = item.asin || item.product_url || ''
    return /\/dp\/([A-Z0-9]{10})|^([A-Z0-9]{10})$/.test(src)
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function CartScreen() {
  const [cart, setCart] = useState<Cart | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [aiSummary, setAISummary] = useState<string | null>(null)

  const toastAnim = useRef(new Animated.Value(-80)).current

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null

    async function init() {
      await fetchLatestCart()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      channel = supabase
        .channel('cart-ready')
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'carts',
        }, (payload) => {
          if (payload.new.user_id === user.id) {
            fetchLatestCart()
            showToast()
          }
        })
        .subscribe()
    }

    init()
    return () => { channel?.unsubscribe() }
  }, [])

  function showToast() {
    Animated.spring(toastAnim, { toValue: 0, useNativeDriver: true, tension: 80 }).start()
    setTimeout(() => {
      Animated.spring(toastAnim, { toValue: -80, useNativeDriver: true }).start()
    }, 4000)
  }

  async function fetchLatestCart(isRefresh = false) {
    if (!isRefresh) setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }
    const { data: cartData } = await supabase
      .from('carts')
      .select('*, items:cart_items(*)')
      .eq('user_id', user.id)
      .neq('status', 'checked_out')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    const newCart = cartData ?? null
    setCart(newCart)
    setLoading(false)
    setRefreshing(false)

    if (newCart?.items?.length) {
      fetchAISummary(newCart.items)
    }
  }

  async function fetchAISummary(items: CartItem[]) {
    setAISummary(null)
    const { data } = await supabase.functions.invoke('explain-cart', {
      body: { cart_items: items },
    })
    if (data?.summary) setAISummary(data.summary)
  }

  async function handleRefresh() {
    setRefreshing(true)
    setAISummary(null)
    await fetchLatestCart(true)
  }

  async function removeCartItem(itemId: string) {
    await supabase.from('cart_items').delete().eq('id', itemId)
    const remaining = (cart?.items ?? []).filter(i => i.id !== itemId)
    if (remaining.length === 0 && cart) {
      await supabase.from('carts').delete().eq('id', cart.id)
      setCart(null)
    } else {
      setCart(prev => prev ? {
        ...prev,
        items: remaining,
        total: remaining.reduce((s, i) => s + i.price, 0),
      } : null)
    }
  }

  async function markCheckedOut() {
    if (!cart) return
    await supabase.from('carts').update({ status: 'checked_out' }).eq('id', cart.id)
    setCart(null)
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const Toast = (
    <Animated.View style={[styles.toast, { transform: [{ translateY: toastAnim }] }]}>
      <Text style={styles.toastText}>Your cart is ready!</Text>
    </Animated.View>
  )

  if (loading) return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        <Text style={styles.loadingText}>Loading cart...</Text>
      </View>
    </SafeAreaView>
  )

  if (!cart || cart.items.length === 0) return (
    <SafeAreaView style={styles.container}>
      {Toast}
      <View style={styles.header}>
        <Text style={styles.title}>Cart</Text>
      </View>
      <View style={styles.center}>
        <Text style={styles.emptyIcon}>🛒</Text>
        <Text style={styles.emptyTitle}>No cart ready yet</Text>
        <Text style={styles.emptyText}>
          Run Restock from the Shop tab to get your AI-curated Amazon picks.
        </Text>
      </View>
    </SafeAreaView>
  )

  const total = cart.items.reduce((sum, item) => sum + item.price, 0)
  const cartDate = new Date(cart.created_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
  const canOpenAmazon = hasAmazonASINs(cart.items)

  return (
    <SafeAreaView style={styles.container}>
      {Toast}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Cart</Text>
          <Text style={styles.subtitle}>
            {cart.items.length} {cart.items.length === 1 ? 'item' : 'items'} · AI picked on {cartDate}
          </Text>
        </View>
      </View>

      <FlatList
        data={cart.items}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />
        }
        ListHeaderComponent={
          aiSummary ? (
            <View style={styles.aiSummaryCard}>
              <Ionicons name="sparkles" size={14} color={colors.primary} />
              <Text style={styles.aiSummaryText}>{aiSummary}</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.cartItem}>
            {item.image_url ? (
              <Image
                source={{ uri: item.image_url }}
                style={styles.productImage}
                resizeMode="contain"
              />
            ) : (
              <View style={[styles.productImage, styles.imagePlaceholder]}>
                <Text style={styles.imagePlaceholderText}>
                  {item.product_name?.charAt(0)?.toUpperCase() ?? '?'}
                </Text>
              </View>
            )}
            <View style={styles.productInfo}>
              <Text style={styles.productName} numberOfLines={2}>{item.product_name}</Text>
              <Text style={styles.productStore}>{item.store}</Text>
              <Text style={styles.productFor}>for "{item.grocery_item_name}"</Text>
              {item.quantity && item.quantity !== '1' && (
                <Text style={styles.productQty}>Qty: {item.quantity}</Text>
              )}
            </View>
            <View style={styles.productRight}>
              <Text style={styles.productPrice}>${item.price.toFixed(2)}</Text>
              <TouchableOpacity onPress={() => removeCartItem(item.id)} style={styles.removeBtn}>
                <Text style={styles.removeBtnText}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListFooterComponent={
          <View style={styles.footerCard}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Estimated Total</Text>
              <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
            </View>
            <Text style={styles.footerNote}>Final price may vary at checkout</Text>
            <Text style={styles.footerNoteXs}>Amazon cart is built from ASINs in product URLs</Text>
          </View>
        }
      />

      <View style={styles.checkoutBar}>
        {canOpenAmazon ? (
          <TouchableOpacity
            style={styles.checkoutBtn}
            onPress={() => {
              Linking.openURL(buildAmazonCartUrl(cart.items))
              markCheckedOut()
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.checkoutBtnText}>Open Amazon Cart →</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.checkoutBtn}
            onPress={() => Linking.openURL('https://www.amazon.ca')}
            activeOpacity={0.85}
          >
            <Text style={styles.checkoutBtnText}>View Amazon.ca →</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  loadingText: { color: colors.textSecondary, fontSize: font.size.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: { fontSize: font.size.xxl, fontWeight: '800', color: colors.textPrimary },
  subtitle: { fontSize: font.size.sm, color: colors.textSecondary, marginTop: 2 },
  emptyIcon: { fontSize: 48, marginBottom: spacing.md },
  emptyTitle: {
    fontSize: font.size.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  emptyText: {
    fontSize: font.size.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 120,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  aiSummaryCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  aiSummaryText: {
    flex: 1,
    fontSize: font.size.sm,
    color: colors.primary,
    fontWeight: '600',
    lineHeight: 20,
  },
  cartItem: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  productImage: {
    width: 64,
    height: 64,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryLight,
  },
  imagePlaceholderText: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.primary,
  },
  productInfo: { flex: 1, gap: 2 },
  productName: {
    fontSize: font.size.sm,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 18,
  },
  productStore: {
    fontSize: font.size.xs,
    color: colors.primary,
    fontWeight: '600',
    marginTop: 2,
  },
  productFor: { fontSize: font.size.xs, color: colors.textMuted },
  productQty: { fontSize: font.size.xs, color: colors.textSecondary, fontWeight: '500' },
  productRight: { alignItems: 'flex-end', gap: spacing.sm },
  productPrice: {
    fontSize: font.size.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  removeBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: colors.dangerLight,
  },
  removeBtnText: { fontSize: font.size.xs, color: colors.danger, fontWeight: '600' },
  footerCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: { fontSize: font.size.md, fontWeight: '600', color: colors.textPrimary },
  totalValue: { fontSize: font.size.xl, fontWeight: '800', color: colors.primary },
  footerNote: { fontSize: font.size.xs, color: colors.textMuted, marginTop: 2 },
  footerNoteXs: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  checkoutBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.md,
    paddingBottom: spacing.xl,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  checkoutBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
  },
  checkoutBtnText: { color: '#fff', fontSize: font.size.md, fontWeight: '700' },
  toast: {
    position: 'absolute',
    top: 0,
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 100,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  toastText: { color: '#fff', fontWeight: '700', fontSize: font.size.md },
})
