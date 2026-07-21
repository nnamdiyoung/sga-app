import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, SafeAreaView, Image, Modal, ActivityIndicator, Linking, RefreshControl, Animated
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { WebView } from 'react-native-webview'
import type { WebView as WebViewType } from 'react-native-webview'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font } from '../../lib/theme'
import type { Cart, CartItem } from '../../lib/types'

// ---------------------------------------------------------------------------
// Intercept fetch calls made by Instacart's own page to capture cartId and
// retailerLocationId before we inject the mutation.
// ---------------------------------------------------------------------------
const INSTACART_INTERCEPT_JS = `
window.__ctx={cid:null,lid:null};
(function(){
  var o=window.fetch;window.__f=o;
  window.fetch=function(){
    return o.apply(this,arguments).then(function(r){
      r.clone().json().then(function(j){
        var s=JSON.stringify(j);
        if(!window.__ctx.cid){var m=s.match(/"cartId":"(\\d+)"/);if(m)window.__ctx.cid=m[1];}
        if(!window.__ctx.lid){var m2=s.match(/"retailerLocationId":"(\\d+)"/);if(m2)window.__ctx.lid=m2[1];}
        if(!window.__ctx.lid){var m3=s.match(/"v4ItemId":"items_(\\d+)-/);if(m3)window.__ctx.lid=m3[1];}
      }).catch(function(){});
      return r;
    });
  };
})();
true;
`

// ---------------------------------------------------------------------------
// Build the JS that fires the UpdateCartItemsMutation for all items at once.
// ---------------------------------------------------------------------------
function makeAddJS(items: { productId: string; qty: number }[]): string {
  return `(function(items){
  var ctx=window.__ctx;var f=window.__f||window.fetch;
  function go(){
    f('/graphql?operationName=UpdateCartItemsMutation',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-client-identifier':'web'},
      credentials:'include',
      body:JSON.stringify({
        operationName:'UpdateCartItemsMutation',
        variables:{
          cartId:ctx.cid,
          cartItemUpdates:items.map(function(i){return{
            itemId:'items_'+ctx.lid+'-'+i.productId,
            quantity:i.qty,quantityType:'each',
            trackingParams:{attributionMetadata:{shopId:'',nestedShopId:''},trackingProperties:{}}
          };}),
          cartType:'grocery',requestTimestamp:Date.now()
        },
        extensions:{persistedQuery:{version:1,sha256Hash:'ba4bf465d294d1d528d82a4ac48ac13980d528149874c0e52082dc1d833bdb09'}}
      })
    }).then(function(r){return r.json();}).then(function(d){
      var c=d&&d.data&&d.data.updateCartItems&&d.data.updateCartItems.cart;
      var updatedIds=(d&&d.data&&d.data.updateCartItems&&d.data.updateCartItems.updatedItemIds)||[];
      window.ReactNativeWebView.postMessage(JSON.stringify({ok:!!c,count:c?c.itemCount:0,added:updatedIds.length,err:d.errors?d.errors[0].message:null}));
    }).catch(function(e){
      window.ReactNativeWebView.postMessage(JSON.stringify({ok:false,err:String(e)}));
    });
  }
  var n=0;
  function poll(){
    if(!ctx.cid||!ctx.lid){
      try{
        var nd=JSON.stringify(window.__NEXT_DATA__||{});
        if(!ctx.cid){var m=nd.match(/"cartId":"(\\d+)"/);if(m)ctx.cid=m[1];}
        if(!ctx.lid){var m2=nd.match(/"retailerLocationId":"(\\d+)"/);if(m2)ctx.lid=m2[1];}
        if(!ctx.lid){var m3=nd.match(/"v4ItemId":"items_(\\d+)-/);if(m3)ctx.lid=m3[1];}
      }catch(e){}
    }
    if(ctx.cid&&ctx.lid){go();return;}
    n++;
    if(n<24)setTimeout(poll,500);
    else window.ReactNativeWebView.postMessage(JSON.stringify({ok:false,err:'session_expired'}));
  }
  poll();
})(${JSON.stringify(items)});
true;`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractProductId(url: string): string | null {
  const m = url.match(/\/products\/(\d+)/)
  return m ? m[1] : null
}

function parseQty(quantity?: string): number {
  if (!quantity) return 1
  const trimmed = quantity.trim()
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10)
    return Math.max(1, Math.min(n, 20))
  }
  return 1
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function CartScreen() {
  const [cart, setCart] = useState<Cart | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [aiSummary, setAISummary] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Instacart GraphQL flow state
  const [instacartPhase, setInstacartPhase] = useState<'idle' | 'loading' | 'adding' | 'done' | 'error'>('idle')
  const [instacartCount, setInstacartCount] = useState(0)
  const [showInstacartFlow, setShowInstacartFlow] = useState(false)
  const [webViewKey, setWebViewKey] = useState(0)
  const [instacartUrl, setInstacartUrl] = useState('https://www.instacart.ca')

  const router = useRouter()
  const instacartWebViewRef = useRef<WebViewType>(null)
  const pendingItemsRef = useRef<{ productId: string; qty: number }[]>([])
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
      setSelectedIds(new Set(newCart.items.map((i: CartItem) => i.id)))
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

  function toggleItem(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (!cart) return
    if (selectedIds.size === cart.items.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(cart.items.map(i => i.id)))
    }
  }

  // ---------------------------------------------------------------------------
  // Instacart GraphQL flow
  // ---------------------------------------------------------------------------
  function startInstacartAdd(cartItems: CartItem[]) {
    const items = cartItems
      .filter(i => !!i.product_url && !i.product_name?.startsWith('Search for "'))
      .map(i => {
        const productId = extractProductId(i.product_url)
        if (!productId) console.warn('[SGA] No productId from URL:', i.product_url)
        return productId ? { productId, qty: parseQty(i.quantity) } : null
      })
      .filter((i): i is { productId: string; qty: number } => i !== null)

    console.log(`[SGA] startInstacartAdd: ${items.length} of ${cartItems.length} items have valid productIds`)

    if (items.length === 0) return

    // Use a store-specific URL so Instacart makes cart API calls immediately
    const firstUrl = cartItems.find(i => i.product_url?.includes('/store/'))?.product_url ?? ''
    const storeSlugMatch = firstUrl.match(/\/store\/([^/?#]+)/)
    const storeUrl = storeSlugMatch
      ? `https://www.instacart.ca/store/${storeSlugMatch[1]}`
      : 'https://www.instacart.ca'

    pendingItemsRef.current = items
    setInstacartUrl(storeUrl)
    setWebViewKey(k => k + 1) // force fresh WebView mount
    setInstacartPhase('loading')
    setInstacartCount(0)
    setShowInstacartFlow(true)
  }

  function handleInstacartLoad() {
    setInstacartPhase('adding')
    instacartWebViewRef.current?.injectJavaScript(makeAddJS(pendingItemsRef.current))
  }

  async function handleInstacartMessage(event: { nativeEvent: { data: string } }) {
    try {
      const data = JSON.parse(event.nativeEvent.data) as { ok: boolean; count?: number; added?: number; err?: string | null }
      console.log('[SGA] Instacart API result:', JSON.stringify(data))

      if (data.ok) {
        setInstacartCount(data.added ?? data.count ?? pendingItemsRef.current.length)
        setInstacartPhase('done')
        if (cart) {
          await supabase.from('carts').update({ status: 'checked_out', instacart_added: true }).eq('id', cart.id)
          setCart(null)
        }
      } else {
        setInstacartPhase('error')
      }
    } catch {
      setInstacartPhase('error')
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const Toast = (
    <Animated.View style={[styles.toast, { transform: [{ translateY: toastAnim }] }]}>
      <Text style={styles.toastText}>🛒 Your cart is ready!</Text>
    </Animated.View>
  )

  if (loading) return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}><Text style={styles.loadingText}>Loading cart...</Text></View>
    </SafeAreaView>
  )

  if (!cart || cart.items.length === 0) return (
    <SafeAreaView style={styles.container}>
      {Toast}
      <View style={styles.header}><Text style={styles.title}>Cart</Text></View>
      <View style={styles.center}>
        <Text style={styles.emptyIcon}>🛒</Text>
        <Text style={styles.emptyTitle}>No cart ready yet</Text>
        <Text style={styles.emptyText}>
          Once SGA runs on your scheduled day, your AI-curated cart will appear here for review.
        </Text>
      </View>
    </SafeAreaView>
  )

  const total = cart.items.reduce((sum, item) => sum + item.price, 0)

  return (
    <SafeAreaView style={styles.container}>
      {Toast}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Your Cart</Text>
          <Text style={styles.subtitle}>
            {cart.items.length} items · AI picked on {new Date(cart.created_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
          </Text>
        </View>
        {!cart.instacart_added && (
          <TouchableOpacity onPress={toggleAll} style={styles.selectAllBtn}>
            <Text style={styles.selectAllText}>
              {selectedIds.size === cart.items.length ? 'Deselect All' : 'Select All'}
            </Text>
          </TouchableOpacity>
        )}
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
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => !cart?.instacart_added && toggleItem(item.id)}
            style={[styles.cartItem, !cart?.instacart_added && !selectedIds.has(item.id) && styles.cartItemUnselected]}
          >
            {!cart?.instacart_added && (
              <View style={[styles.checkbox, selectedIds.has(item.id) && styles.checkboxChecked]}>
                {selectedIds.has(item.id) && <Text style={styles.checkboxTick}>✓</Text>}
              </View>
            )}
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
          </TouchableOpacity>
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Estimated Total</Text>
              <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
            </View>
            <Text style={styles.footerNote}>Final price may vary at checkout</Text>
          </View>
        }
      />

      <View style={styles.checkoutBar}>
        {cart.instacart_added ? (
          <TouchableOpacity
            style={styles.checkoutBtn}
            onPress={() => { Linking.openURL('https://www.instacart.ca'); markCheckedOut() }}
          >
            <Text style={styles.checkoutBtnText}>Open Instacart to Checkout →</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.checkoutBtn, selectedIds.size === 0 && styles.checkoutBtnDisabled]}
            disabled={selectedIds.size === 0}
            onPress={() => startInstacartAdd(cart.items.filter(i => selectedIds.has(i.id)))}
          >
            <Text style={styles.checkoutBtnText}>
              {selectedIds.size === cart.items.length
                ? 'Add All to Instacart Cart'
                : `Add ${selectedIds.size} Item${selectedIds.size === 1 ? '' : 's'} to Instacart`}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Background WebView modal — overlay always covers the Instacart page */}
      <Modal visible={showInstacartFlow} animationType="slide" presentationStyle="fullScreen">
        <SafeAreaView style={styles.modalContainer}>
          {/* Background WebView — hidden behind overlay */}
          <WebView
            key={webViewKey}
            ref={instacartWebViewRef}
            source={{ uri: instacartUrl }}
            style={{ flex: 1 }}
            injectedJavaScriptBeforeContentLoaded={INSTACART_INTERCEPT_JS}
            onLoad={handleInstacartLoad}
            onMessage={handleInstacartMessage}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
          />

          {/* Status overlay — always covers the WebView */}
          <View style={[StyleSheet.absoluteFill, styles.instacartOverlay]}>
            {(instacartPhase === 'loading' || instacartPhase === 'adding') && (
              <View style={styles.instacartLoading}>
                <Text style={styles.instacartEmoji}>🛒</Text>
                <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: spacing.md }} />
                <Text style={styles.instacartTitle}>Adding to your Instacart cart</Text>
                <Text style={styles.instacartSub}>
                  {instacartPhase === 'loading' ? 'Connecting to Instacart...' : 'Adding your items...'}
                </Text>
              </View>
            )}

            {instacartPhase === 'done' && (
              <View style={styles.instacartDone}>
                <Text style={styles.instacartEmoji}>✅</Text>
                <Text style={styles.instacartTitle}>{instacartCount} items in your Instacart cart</Text>
                <Text style={styles.instacartSub}>Ready to checkout</Text>
                <TouchableOpacity
                  style={styles.openBtn}
                  onPress={() => {
                    Linking.openURL('https://www.instacart.ca')
                    setShowInstacartFlow(false)
                  }}
                >
                  <Text style={styles.openBtnText}>Open Instacart →</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.closeBtn} onPress={() => setShowInstacartFlow(false)}>
                  <Text style={styles.closeBtnText}>Done</Text>
                </TouchableOpacity>
              </View>
            )}

            {instacartPhase === 'error' && (
              <View style={styles.instacartError}>
                <Text style={styles.instacartEmoji}>⚠️</Text>
                <Text style={styles.instacartTitle}>Could not connect to Instacart</Text>
                <Text style={styles.instacartSub}>Your session may have expired. Reconnect your account in Profile and try again.</Text>
                <TouchableOpacity
                  style={styles.openBtn}
                  onPress={() => {
                    setShowInstacartFlow(false)
                    router.push('/(tabs)/profile')
                  }}
                >
                  <Text style={styles.openBtnText}>Go to Profile →</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.closeBtn} onPress={() => setShowInstacartFlow(false)}>
                  <Text style={styles.closeBtnText}>Close</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  loadingText: { color: colors.textSecondary },
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
  emptyTitle: { fontSize: font.size.lg, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.sm },
  emptyText: { fontSize: font.size.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.sm },
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
    marginBottom: spacing.sm,
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
  productName: { fontSize: font.size.sm, fontWeight: '600', color: colors.textPrimary, lineHeight: 18 },
  productStore: { fontSize: font.size.xs, color: colors.primary, fontWeight: '600', marginTop: 2 },
  productFor: { fontSize: font.size.xs, color: colors.textMuted },
  productQty: { fontSize: font.size.xs, color: colors.textSecondary, fontWeight: '500' },
  productRight: { alignItems: 'flex-end', gap: spacing.sm },
  productPrice: { fontSize: font.size.md, fontWeight: '700', color: colors.textPrimary },
  removeBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: colors.dangerLight,
  },
  removeBtnText: { fontSize: font.size.xs, color: colors.danger, fontWeight: '600' },
  footer: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { fontSize: font.size.md, fontWeight: '600', color: colors.textPrimary },
  totalValue: { fontSize: font.size.xl, fontWeight: '800', color: colors.primary },
  footerNote: { fontSize: font.size.xs, color: colors.textMuted, marginTop: spacing.xs },
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
  checkoutBtnDisabled: {
    backgroundColor: colors.border,
  },
  checkoutBtnText: { color: '#fff', fontSize: font.size.md, fontWeight: '700' },
  selectAllBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  selectAllText: {
    fontSize: font.size.sm,
    color: colors.primary,
    fontWeight: '600',
  },
  cartItemUnselected: {
    opacity: 0.45,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxTick: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
  openInstacartBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    width: '100%',
  },
  openInstacartBtnText: { color: '#fff', fontWeight: '700', fontSize: font.size.md },
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
  // Modal
  modalContainer: { flex: 1, backgroundColor: colors.background },
  instacartOverlay: {
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  instacartLoading: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  instacartDone: {
    alignItems: 'center',
    gap: spacing.md,
    width: '100%',
  },
  instacartError: {
    alignItems: 'center',
    gap: spacing.md,
    width: '100%',
  },
  instacartEmoji: {
    fontSize: 52,
    marginBottom: spacing.sm,
  },
  instacartTitle: {
    fontSize: font.size.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  instacartSub: {
    fontSize: font.size.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  openBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    width: '100%',
    alignItems: 'center',
  },
  openBtnText: { color: '#fff', fontWeight: '700', fontSize: font.size.md },
  closeBtn: {
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  closeBtnText: { fontSize: font.size.sm, color: colors.textSecondary },
})
