import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, SafeAreaView, Image, Alert, Modal, ActivityIndicator, Linking, RefreshControl, Animated, ScrollView
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { WebView } from 'react-native-webview'
import type { WebView as WebViewType } from 'react-native-webview'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font } from '../../lib/theme'
import type { Cart, CartItem } from '../../lib/types'

function parseQty(quantity?: string): number {
  if (!quantity) return 1
  const n = parseInt(quantity.match(/\d+/)?.[0] ?? '1', 10)
  return Math.max(1, isNaN(n) ? 1 : n)
}

function makeInjectJS(qty: number): string {
  return `(function() {
  var ogImg = '';
  var metaOg = document.querySelector('meta[property="og:image"]');
  if (metaOg) ogImg = metaOg.getAttribute('content') || '';

  var clicked = false;
  var allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
  var btnTexts = allBtns.slice(0, 30).map(function(b) {
    return (b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 50);
  });

  var candidates = [
    '[data-testid="add-item-to-cart-button"]',
    '[data-testid*="add_to_cart"]',
    '[data-testid*="add-to-cart"]',
  ];
  for (var i = 0; i < candidates.length; i++) {
    var el = document.querySelector(candidates[i]);
    if (el) { el.click(); clicked = true; break; }
  }

  if (!clicked) {
    for (var j = 0; j < allBtns.length; j++) {
      var btn = allBtns[j];
      var lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
      var txt = (btn.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (lbl.includes('add to cart') || lbl.includes('add item') ||
          txt === 'add to cart' || txt === 'add item' || txt === 'add' ||
          txt.startsWith('add to')) {
        btn.click(); clicked = true; break;
      }
    }
  }

  var targetQty = ${qty};
  if (clicked && targetQty > 1) {
    var done = 0;
    var needed = targetQty - 1;
    function inc() {
      if (done >= needed) return;
      var incEl = document.querySelector(
        '[aria-label*="increase" i],[aria-label*="increment" i],[data-testid*="increment"],[aria-label*="add more" i]'
      );
      if (!incEl) {
        var bs = Array.from(document.querySelectorAll('button'));
        for (var k = 0; k < bs.length; k++) {
          if ((bs[k].textContent || '').trim() === '+') { incEl = bs[k]; break; }
        }
      }
      if (incEl) { incEl.click(); done++; }
      if (done < needed) setTimeout(inc, 700);
    }
    setTimeout(inc, 1500);
  }

  window.ReactNativeWebView.postMessage(JSON.stringify({
    clicked: clicked, image: ogImg, url: window.location.href,
    title: document.title, btnTexts: btnTexts
  }));
})();
true;`
}

export default function CartScreen() {
  const [cart, setCart] = useState<Cart | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [aiSummary, setAISummary] = useState<string | null>(null)
  const [showAddFlow, setShowAddFlow] = useState(false)
  const [addQueue, setAddQueue] = useState<CartItem[]>([])
  const [addIndex, setAddIndex] = useState(0)
  const [addStatus, setAddStatus] = useState<'idle' | 'adding' | 'done'>('idle')
  const [addedCount, setAddedCount] = useState(0)
  const [isPageLoading, setIsPageLoading] = useState(false)
  const [needsManual, setNeedsManual] = useState(false)
  const [showFlash, setShowFlash] = useState(false)

  const webViewRef = useRef<WebViewType>(null)
  const addedRef = useRef(0)
  const indexRef = useRef(0)
  const queueRef = useRef<CartItem[]>([])
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  function startAddToInstacart() {
    if (!cart || cart.items.length === 0) return
    const instacartItems = cart.items.filter(i => !!i.product_url)
    if (instacartItems.length === 0) {
      Alert.alert('No items', 'No product links found in this cart.')
      return
    }
    addedRef.current = 0
    indexRef.current = 0
    queueRef.current = instacartItems
    setAddedCount(0)
    setAddQueue(instacartItems)
    setAddIndex(0)
    setNeedsManual(false)
    setIsPageLoading(true)
    setAddStatus('adding')
    setShowAddFlow(true)
  }

  function advanceToNext() {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current)
      flashTimerRef.current = null
    }
    setShowFlash(false)
    const nextIndex = indexRef.current + 1
    indexRef.current = nextIndex
    if (nextIndex < queueRef.current.length) {
      setAddIndex(nextIndex)
      setNeedsManual(false)
      setIsPageLoading(true)
    } else {
      setAddStatus('done')
    }
  }

  function handleWebViewLoad() {
    const item = queueRef.current[indexRef.current]
    const qty = parseQty(item?.quantity)
    setTimeout(() => {
      webViewRef.current?.injectJavaScript(makeInjectJS(qty))
      setIsPageLoading(false)
    }, 8000)
  }

  async function handleWebViewMessage(event: { nativeEvent: { data: string } }) {
    try {
      const data = JSON.parse(event.nativeEvent.data)
      console.log('[SGA] WebView msg:', JSON.stringify(data))

      const currentItem = queueRef.current[indexRef.current]
      if (data.image && currentItem) {
        supabase.from('cart_items')
          .update({ image_url: data.image })
          .eq('id', currentItem.id)
          .then(() => {
            setCart(prev => {
              if (!prev) return prev
              return {
                ...prev,
                items: prev.items.map(i =>
                  i.id === currentItem.id ? { ...i, image_url: data.image } : i
                )
              }
            })
          })
      }

      if (data.clicked) {
        addedRef.current += 1
        setAddedCount(addedRef.current)
        setShowFlash(true)
        flashTimerRef.current = setTimeout(() => {
          setShowFlash(false)
          advanceToNext()
        }, 1500)
      } else {
        setNeedsManual(true)
      }
    } catch { /* ignore */ }
  }

  function handleDone() {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current)
      flashTimerRef.current = null
    }
    setShowAddFlow(false)
    setAddStatus('idle')
    setAddIndex(0)
    setAddQueue([])
    setNeedsManual(false)
    setShowFlash(false)
    setIsPageLoading(false)
    indexRef.current = 0
    queueRef.current = []
  }

  function openInstacart() {
    Linking.openURL('https://www.instacart.ca')
    markCheckedOut()
    handleDone()
  }

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
  const currentItem = addQueue[addIndex]

  return (
    <SafeAreaView style={styles.container}>
      {Toast}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Your Cart</Text>
          <Text style={styles.subtitle}>
            {cart.items.length} items · AI picked on {new Date(cart.created_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
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
        <TouchableOpacity style={styles.checkoutBtn} onPress={startAddToInstacart}>
          <Text style={styles.checkoutBtnText}>Add to Instacart Cart</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={showAddFlow} animationType="slide" presentationStyle="fullScreen">
        <SafeAreaView style={styles.modalContainer}>

          {/* Top banner */}
          <View style={styles.addHeader}>
            {addStatus === 'adding' ? (
              <View style={styles.addHeaderContent}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.addHeaderTitle} numberOfLines={1}>
                    {currentItem?.grocery_item_name}
                  </Text>
                  <Text style={styles.addHeaderSub}>
                    {isPageLoading ? 'Loading product page...' : needsManual ? 'Tap "Add to cart" on the page below' : 'Adding to cart...'}
                    {'  '}{addIndex + 1}/{addQueue.length}
                  </Text>
                </View>
                {isPageLoading && <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: spacing.sm }} />}
                <TouchableOpacity onPress={handleDone} style={styles.closeX}>
                  <Text style={styles.closeXText}>✕</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.addHeaderContent}>
                <Text style={styles.addHeaderTitle}>
                  {addedCount === addQueue.length ? '✅' : '⚠️'} {addedCount} of {addQueue.length} items added
                </Text>
                <TouchableOpacity onPress={handleDone} style={styles.closeX}>
                  <Text style={styles.closeXText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {addStatus === 'adding' && currentItem?.product_url ? (
            <View style={{ flex: 1 }}>
              <WebView
                ref={webViewRef}
                source={{ uri: currentItem.product_url }}
                style={{ flex: 1 }}
                onLoad={handleWebViewLoad}
                onMessage={handleWebViewMessage}
                javaScriptEnabled
                domStorageEnabled
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
                userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
              />

              {/* "Added!" flash — brief overlay after successful auto-click */}
              {showFlash && (
                <View style={styles.flashOverlay}>
                  <Text style={styles.flashIcon}>✓</Text>
                  <Text style={styles.flashText}>Added!</Text>
                </View>
              )}

              {/* Manual bottom bar — only shows when auto-click failed */}
              {needsManual && !showFlash && (
                <View style={styles.manualBar}>
                  <Text style={styles.manualText}>Tap "Add to cart" above, then:</Text>
                  <View style={styles.manualActions}>
                    <TouchableOpacity style={styles.skipBtn} onPress={advanceToNext}>
                      <Text style={styles.skipBtnText}>Skip</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.nextBtn} onPress={() => {
                      addedRef.current += 1
                      setAddedCount(addedRef.current)
                      advanceToNext()
                    }}>
                      <Text style={styles.nextBtnText}>Added — Next →</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          ) : addStatus === 'done' ? (
            <View style={styles.doneContainer}>
              <Text style={styles.doneIcon}>
                {addedCount === addQueue.length ? '✅' : '⚠️'}
              </Text>
              <Text style={styles.doneTitle}>
                {addedCount} of {addQueue.length} items added to Instacart
              </Text>
              <Text style={styles.doneSub}>
                {addedCount > 0
                  ? 'Open Instacart to review your cart and checkout'
                  : 'Could not add items automatically — open Instacart to add manually'}
              </Text>
              <TouchableOpacity style={styles.openInstacartBtn} onPress={openInstacart}>
                <Text style={styles.openInstacartBtnText}>Open Instacart →</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.closeDoneBtn} onPress={handleDone}>
                <Text style={styles.closeDoneBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          ) : null}

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
  modalContainer: { flex: 1, backgroundColor: colors.background },
  addHeader: {
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  addHeaderContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  addHeaderTitle: {
    fontSize: font.size.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  addHeaderSub: {
    fontSize: font.size.xs,
    color: colors.textSecondary,
    marginTop: 2,
  },
  closeX: {
    padding: spacing.sm,
    marginLeft: spacing.sm,
  },
  closeXText: {
    fontSize: font.size.md,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  flashOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0, 150, 0, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  flashIcon: {
    fontSize: 64,
    color: '#fff',
  },
  flashText: {
    fontSize: font.size.xxl,
    fontWeight: '800',
    color: '#fff',
  },
  manualBar: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  manualText: {
    fontSize: font.size.sm,
    color: colors.textPrimary,
    fontWeight: '600',
    textAlign: 'center',
  },
  manualActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  skipBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  skipBtnText: {
    fontSize: font.size.sm,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  nextBtn: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  nextBtnText: {
    fontSize: font.size.sm,
    color: '#fff',
    fontWeight: '700',
  },
  doneContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  doneIcon: { fontSize: 52, marginBottom: spacing.sm },
  doneTitle: { fontSize: font.size.lg, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  doneSub: { fontSize: font.size.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  openInstacartBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    width: '100%',
    alignItems: 'center',
  },
  openInstacartBtnText: { color: '#fff', fontWeight: '700', fontSize: font.size.md },
  closeDoneBtn: {
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  closeDoneBtnText: { fontSize: font.size.sm, color: colors.textSecondary },
})
