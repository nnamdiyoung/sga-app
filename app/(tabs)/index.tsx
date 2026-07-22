import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  SafeAreaView, Image, Linking, Alert, ActivityIndicator, RefreshControl, ScrollView,
} from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font, shadow } from '../../lib/theme'
import type { Cart, CartItem } from '../../lib/types'

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

function getFirstName(user: any): string {
  const raw =
    user?.user_metadata?.full_name?.split(' ')?.[0] ||
    user?.email?.split('@')?.[0]?.split('.')?.[0] ||
    'there'
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

function StarRating({ rating }: { rating: number }) {
  return (
    <View style={styles.starsRow}>
      {[1, 2, 3, 4, 5].map(i => (
        <Ionicons
          key={i}
          name={rating >= i ? 'star' : rating >= i - 0.5 ? 'star-half' : 'star-outline'}
          size={12}
          color={colors.primary}
        />
      ))}
    </View>
  )
}

export default function HomeScreen() {
  const [firstName, setFirstName] = useState('there')
  const [cart, setCart] = useState<Cart | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [shopping, setShopping] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const userIdRef = useRef<string | null>(null)

  useEffect(() => {
    init()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function init() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    userIdRef.current = user.id
    setFirstName(getFirstName(user))
    await fetchCart(user.id)
    setLoading(false)
  }

  async function fetchCart(userId?: string): Promise<Cart | null> {
    const uid = userId || userIdRef.current
    if (!uid) return null
    const { data } = await supabase
      .from('carts')
      .select('*, items:cart_items(*)')
      .eq('user_id', uid)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setCart(data ?? null)
    return data ?? null
  }

  function startPollingForCart() {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const found = await fetchCart()
      if (found) {
        clearInterval(pollRef.current!)
        pollRef.current = null
        setAgentRunning(false)
      }
    }, 15000)
  }

  async function shopNow() {
    setShopping(true)
    try {
      const { data, error } = await supabase.functions.invoke('trigger-shopping-agent', { body: {} })
      if (error || !data?.success) {
        Alert.alert('Error', error?.message ?? data?.error ?? 'Could not start Restock.')
        setShopping(false)
        return
      }
      setShopping(false)
      setAgentRunning(true)
      startPollingForCart()
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not start.')
      setShopping(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    await fetchCart()
    setRefreshing(false)
  }

  function openAmazonCart() {
    if (!cart?.items?.length) return
    Linking.openURL(buildAmazonCartUrl(cart.items))
  }

  const total = cart?.items?.reduce((s, i) => s + i.price, 0) ?? 0
  const itemCount = cart?.items?.length ?? 0

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.brandDot} />
            <Text style={styles.brandLabel}>RESTOCK</Text>
          </View>
          <Text style={styles.greeting}>Ready to restock,{'\n'}{firstName}?</Text>
          <Text style={styles.greetingSub}>Here's what's ready this month</Text>
        </View>

        {/* Cart state card */}
        {agentRunning ? (
          <View style={[styles.cartCard, styles.cartCardActive]}>
            <View style={styles.cartCardRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cartCardLabel}>SHOPPING NOW</Text>
                <Text style={styles.cartCardTitle}>Shopping on Amazon...</Text>
                <Text style={styles.cartCardSub}>Finding best products for you (~2 min)</Text>
              </View>
              <ActivityIndicator color={colors.primary} size="small" />
            </View>
          </View>
        ) : cart && itemCount > 0 ? (
          <View style={[styles.cartCard, styles.cartCardActive]}>
            <Text style={styles.cartCardLabel}>MONTHLY CART</Text>
            <Text style={styles.cartCardTitle}>Your monthly cart is ready</Text>
            <Text style={styles.cartCardSub}>
              {itemCount} item{itemCount !== 1 ? 's' : ''} · est. ${total.toFixed(0)} · AI curated today
            </Text>
            <TouchableOpacity style={styles.openCartBtn} onPress={openAmazonCart}>
              <Text style={styles.openCartBtnText}>Open Amazon Cart →</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.cartCard}>
            <View style={styles.cartCardRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cartCardTitle}>Ready to shop?</Text>
                <Text style={styles.cartCardSub}>Run Restock to find the best deals on Amazon</Text>
              </View>
              <TouchableOpacity
                style={[styles.shopNowBtn, shopping && styles.shopNowBtnDisabled]}
                onPress={shopNow}
                disabled={shopping}
              >
                {shopping
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.shopNowBtnText}>Shop Now</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Smart Picks */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Smart Picks This Month</Text>
          <TouchableOpacity onPress={() => router.push('/(tabs)/cart')}>
            <Text style={styles.seeAll}>See all</Text>
          </TouchableOpacity>
        </View>

        {cart?.items?.length ? (
          cart.items.map(item => (
            <ProductCard key={item.id} item={item} />
          ))
        ) : (
          <View style={styles.emptyPicks}>
            <Text style={styles.emptyPicksText}>
              Your AI-curated picks will appear here after Restock runs.
            </Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/shop')} style={styles.goShopBtn}>
              <Text style={styles.goShopBtnText}>Manage My List →</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function ProductCard({ item }: { item: CartItem }) {
  return (
    <View style={styles.productCard}>
      <View style={styles.productRow}>
        {item.image_url ? (
          <Image source={{ uri: item.image_url }} style={styles.productImage} resizeMode="contain" />
        ) : (
          <View style={[styles.productImage, styles.productImagePlaceholder]}>
            <Text style={styles.productImagePlaceholderText}>
              {item.product_name?.charAt(0)?.toUpperCase() ?? '?'}
            </Text>
          </View>
        )}
        <View style={styles.productInfo}>
          <Text style={styles.productName} numberOfLines={2}>{item.product_name}</Text>
          <Text style={styles.productBrand}>{item.store}</Text>
          {item.rating !== undefined && (
            <View style={styles.ratingRow}>
              <StarRating rating={item.rating} />
              <Text style={styles.ratingText}>
                {item.rating.toFixed(1)}{item.review_count ? ` · ${item.review_count.toLocaleString()} reviews` : ''}
              </Text>
            </View>
          )}
          <Text style={styles.productPrice}>${item.price.toFixed(2)}</Text>
          {item.ai_note ? (
            <Text style={styles.aiNote}>{item.ai_note}</Text>
          ) : null}
        </View>
        <View style={styles.aiBadge}>
          <Text style={styles.aiBadgeText}>Ai pick</Text>
        </View>
      </View>
      <TouchableOpacity style={styles.swapBtn}>
        <Text style={styles.swapBtnText}>Swap</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl },

  // Header
  header: { gap: spacing.xs, marginBottom: spacing.sm },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.xs },
  brandDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
  brandLabel: {
    fontSize: 11, fontWeight: '800', color: colors.primary,
    letterSpacing: 2, textTransform: 'uppercase',
  },
  greeting: {
    fontSize: font.size.xxl, fontWeight: '800', color: colors.textPrimary,
    lineHeight: 34,
  },
  greetingSub: { fontSize: font.size.sm, color: colors.textMuted, marginTop: 2 },

  // Cart card
  cartCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  cartCardActive: { borderColor: colors.primary },
  cartCardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cartCardLabel: {
    fontSize: 11, fontWeight: '800', color: colors.primary,
    letterSpacing: 1.5, textTransform: 'uppercase',
  },
  cartCardTitle: { fontSize: font.size.lg, fontWeight: '800', color: colors.textPrimary },
  cartCardSub: { fontSize: font.size.sm, color: colors.textSecondary, marginTop: 2 },
  openCartBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  openCartBtnText: { color: '#fff', fontSize: font.size.md, fontWeight: '800' },
  shopNowBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    minWidth: 90,
    alignItems: 'center',
  },
  shopNowBtnDisabled: { opacity: 0.6 },
  shopNowBtnText: { color: '#fff', fontWeight: '700', fontSize: font.size.sm },

  // Section
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: spacing.sm,
  },
  sectionTitle: { fontSize: font.size.md, fontWeight: '800', color: colors.textPrimary },
  seeAll: { fontSize: font.size.sm, color: colors.primary, fontWeight: '600' },

  // Product card
  productCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  productRow: { flexDirection: 'row', gap: spacing.md },
  productImage: { width: 64, height: 64, borderRadius: radius.sm },
  productImagePlaceholder: {
    backgroundColor: colors.cardMid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  productImagePlaceholderText: { fontSize: 24, fontWeight: '800', color: colors.primary },
  productInfo: { flex: 1, gap: 3 },
  productName: { fontSize: font.size.sm, fontWeight: '700', color: colors.textPrimary, lineHeight: 18 },
  productBrand: { fontSize: font.size.xs, color: colors.textSecondary },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  starsRow: { flexDirection: 'row', gap: 1 },
  ratingText: { fontSize: font.size.xs, color: colors.textSecondary },
  productPrice: { fontSize: font.size.sm, fontWeight: '700', color: colors.textPrimary, marginTop: 2 },
  aiNote: { fontSize: font.size.xs, color: colors.textMuted, fontStyle: 'italic', marginTop: 2 },
  aiBadge: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  aiBadgeText: { fontSize: 10, fontWeight: '700', color: colors.primary },
  swapBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  swapBtnText: { fontSize: font.size.xs, fontWeight: '700', color: colors.primary },

  // Empty
  emptyPicks: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.md,
  },
  emptyPicksText: {
    fontSize: font.size.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20,
  },
  goShopBtn: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
  },
  goShopBtnText: { color: colors.primary, fontWeight: '700', fontSize: font.size.sm },
})
