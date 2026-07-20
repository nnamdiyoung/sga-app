import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, SafeAreaView, Image, Alert, Modal, ActivityIndicator, Linking
} from 'react-native'
import { WebView } from 'react-native-webview'
import type { WebView as WebViewType } from 'react-native-webview'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font } from '../../lib/theme'
import type { Cart, CartItem } from '../../lib/types'

// Injected after page settles — grabs OG image, reports page state, clicks Add button
const INJECT_JS = `
(function() {
  var ogImg = '';
  var metaOg = document.querySelector('meta[property="og:image"]');
  if (metaOg) ogImg = metaOg.getAttribute('content') || '';

  var clicked = false;
  var allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
  var btnTexts = allBtns.slice(0, 20).map(function(b) {
    return (b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 40);
  });

  // Try data-testid selectors first
  var candidates = [
    '[data-testid="add-item-to-cart-button"]',
    '[data-testid*="add_to_cart"]',
    '[data-testid*="add-to-cart"]',
  ];
  for (var c of candidates) {
    var el = document.querySelector(c);
    if (el) { el.click(); clicked = true; break; }
  }

  if (!clicked) {
    for (var btn of allBtns) {
      var lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
      var txt = (btn.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (
        lbl.includes('add to cart') || lbl.includes('add item') ||
        txt === 'add to cart' || txt === 'add item' || txt === 'add'
      ) {
        btn.click();
        clicked = true;
        break;
      }
    }
  }

  window.ReactNativeWebView.postMessage(JSON.stringify({
    clicked: clicked,
    image: ogImg,
    url: window.location.href,
    title: document.title,
    btnTexts: btnTexts
  }));
})();
true;
`

export default function CartScreen() {
  const [cart, setCart] = useState<Cart | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddFlow, setShowAddFlow] = useState(false)
  const [addQueue, setAddQueue] = useState<CartItem[]>([])
  const [addIndex, setAddIndex] = useState(0)
  const [addStatus, setAddStatus] = useState<'idle' | 'adding' | 'done'>('idle')
  const [addedCount, setAddedCount] = useState(0)
  const webViewRef = useRef<WebViewType>(null)
  const addedRef = useRef(0)
  const indexRef = useRef(0)
  const queueRef = useRef<CartItem[]>([])

  useEffect(() => {
    fetchLatestCart()
  }, [])

  async function fetchLatestCart() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data: cartData } = await supabase
      .from('carts')
      .select('*, items:cart_items(*)')
      .eq('user_id', user.id)
      .neq('status', 'checked_out')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    setCart(cartData ?? null)
    setLoading(false)
  }

  async function removeCartItem(itemId: string) {
    await supabase.from('cart_items').delete().eq('id', itemId)
    setCart(prev => prev ? {
      ...prev,
      items: prev.items.filter(i => i.id !== itemId),
      total: prev.items.filter(i => i.id !== itemId).reduce((s, i) => s + i.price, 0),
    } : null)
  }

  async function markCheckedOut() {
    if (!cart) return
    await supabase.from('carts').update({ status: 'checked_out' }).eq('id', cart.id)
    setCart(null)
  }

  function startAddToInstacart() {
    if (!cart || cart.items.length === 0) return
    const instacartItems = cart.items.filter(
      i => i.product_url && i.product_url.startsWith('https://www.instacart.ca/products/')
    )
    if (instacartItems.length === 0) {
      Alert.alert('No product links', 'Run the agent again to get direct Instacart product links.')
      return
    }
    addedRef.current = 0
    indexRef.current = 0
    queueRef.current = instacartItems
    setAddedCount(0)
    setAddQueue(instacartItems)
    setAddIndex(0)
    setAddStatus('adding')
    setShowAddFlow(true)
  }

  function handleWebViewLoad() {
    // Give the React SPA time to hydrate and render the Add button
    setTimeout(() => {
      webViewRef.current?.injectJavaScript(INJECT_JS)
    }, 4000)
  }

  async function handleWebViewMessage(event: { nativeEvent: { data: string } }) {
    try {
      const data = JSON.parse(event.nativeEvent.data)
      console.log('[SGA] WebView msg:', JSON.stringify(data))

      // Save the OG image back to Supabase for this cart item
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
      }

      const nextIndex = indexRef.current + 1
      indexRef.current = nextIndex

      if (nextIndex < queueRef.current.length) {
        setAddIndex(nextIndex)
      } else {
        setAddStatus('done')
      }
    } catch { /* ignore */ }
  }

  function handleDone() {
    setShowAddFlow(false)
    setAddStatus('idle')
    setAddIndex(0)
    setAddQueue([])
    indexRef.current = 0
    queueRef.current = []
  }

  function openInstacart() {
    Linking.openURL('https://www.instacart.ca')
    markCheckedOut()
    handleDone()
  }

  if (loading) return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}><Text style={styles.loadingText}>Loading cart...</Text></View>
    </SafeAreaView>
  )

  if (!cart || cart.items.length === 0) return (
    <SafeAreaView style={styles.container}>
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
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Adding to Instacart</Text>
            {addStatus === 'adding' && (
              <Text style={styles.modalSubtitle}>
                {addIndex + 1} of {addQueue.length} — {currentItem?.grocery_item_name}
              </Text>
            )}
          </View>

          {addStatus === 'adding' ? (
            <View style={[styles.progressOverlay, { zIndex: 10 }]}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.progressTitle}>
                Adding {currentItem?.grocery_item_name}...
              </Text>
              <Text style={styles.progressSub}>{currentItem?.product_name}</Text>
              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${(addIndex / addQueue.length) * 100}%` }]} />
              </View>
              <Text style={styles.progressCount}>{addIndex + 1} of {addQueue.length}</Text>
            </View>
          ) : (
            <View style={styles.progressOverlay}>
              <Text style={styles.doneIcon}>
                {addedCount === addQueue.length ? '✅' : '⚠️'}
              </Text>
              <Text style={styles.progressTitle}>
                {addedCount} of {addQueue.length} items added to Instacart
              </Text>
              <Text style={styles.progressSub}>
                {addedCount > 0
                  ? 'Open Instacart to review your cart and checkout'
                  : 'Could not add items automatically — open Instacart to add manually'}
              </Text>
              <TouchableOpacity style={styles.openInstacartBtn} onPress={openInstacart}>
                <Text style={styles.openInstacartBtnText}>Open Instacart →</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.closeBtn} onPress={handleDone}>
                <Text style={styles.closeBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* WebView — full size so the SPA renders properly, overlay sits on top */}
          {addStatus === 'adding' && currentItem?.product_url && (
            <View style={StyleSheet.absoluteFillObject}>
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
                userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
              />
            </View>
          )}
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
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120 },
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
  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  modalTitle: { fontSize: font.size.md, fontWeight: '700', color: colors.textPrimary },
  modalSubtitle: { fontSize: font.size.xs, color: colors.textSecondary, marginTop: 2 },
  progressOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
    zIndex: 10,
  },
  progressTitle: { fontSize: font.size.lg, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  progressSub: { fontSize: font.size.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  progressBar: {
    width: '100%',
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 3 },
  progressCount: { fontSize: font.size.xs, color: colors.textMuted },
  doneIcon: { fontSize: 52, marginBottom: spacing.sm },
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
  closeBtn: {
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  closeBtnText: { fontSize: font.size.sm, color: colors.textSecondary },
  hiddenWebView: { flex: 1 },
})
