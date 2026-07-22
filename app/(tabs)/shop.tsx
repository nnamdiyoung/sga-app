import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, SafeAreaView, KeyboardAvoidingView, Platform,
  Alert, Modal, ActivityIndicator, RefreshControl
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from '@react-navigation/native'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font, shadow } from '../../lib/theme'
import type { GroceryItem } from '../../lib/types'

export default function Shop() {
  const [items, setItems] = useState<GroceryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [itemName, setItemName] = useState('')
  const [itemQty, setItemQty] = useState('')
  const [adding, setAdding] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [cartReady, setCartReady] = useState(false)
  const [aiModalVisible, setAiModalVisible] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const channelRef = useRef<any>(null)
  const userIdRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const agentRunningRef = useRef(false)

  useEffect(() => {
    agentRunningRef.current = agentRunning
  }, [agentRunning])

  useFocusEffect(useCallback(() => {
    if (agentRunningRef.current) startPollingForCart()
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, []))

  async function startPollingForCart() {
    if (pollRef.current) clearInterval(pollRef.current)
    const uid = userIdRef.current
    if (!uid) return

    async function checkCart() {
      const { data } = await supabase
        .from('carts').select('id').eq('user_id', uid!).eq('status', 'pending').limit(1).maybeSingle()
      if (data) {
        setAgentRunning(false)
        setCartReady(true)
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      }
    }

    await checkCart()
    if (!agentRunningRef.current) return
    pollRef.current = setInterval(checkCart, 15000)
  }

  useEffect(() => {
    loadItems()
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
  }, [])

  async function loadItems() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    userIdRef.current = user.id

    const { data, error } = await supabase
      .from('grocery_items')
      .select('*')
      .eq('user_id', user.id)
      .eq('cleared', false)
      .order('added_at', { ascending: false })

    if (!error && data) setItems(data as GroceryItem[])
    setLoading(false)
    subscribeToUpdates(user.id)
  }

  function subscribeToUpdates(userId: string) {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
    }
    const channel = supabase
      .channel('shop-grocery-items')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'grocery_items',
        filter: `user_id=eq.${userId}`,
      }, () => {
        loadItemsSilent(userId)
      })
      .subscribe()
    channelRef.current = channel
  }

  async function loadItemsSilent(userId: string) {
    const { data, error } = await supabase
      .from('grocery_items')
      .select('*')
      .eq('user_id', userId)
      .eq('cleared', false)
      .order('added_at', { ascending: false })
    if (!error && data) setItems(data as GroceryItem[])
  }

  async function onRefresh() {
    setRefreshing(true)
    await loadItems()
    setRefreshing(false)
  }

  async function addItem() {
    const name = itemName.trim()
    if (!name) return
    const userId = userIdRef.current
    if (!userId) return

    setAdding(true)
    const { error } = await supabase.from('grocery_items').insert({
      user_id: userId,
      name,
      quantity: itemQty.trim() || '1',
      notes: '',
      cleared: false,
    })

    if (!error) {
      setItemName('')
      setItemQty('')
      await loadItemsSilent(userId)
    } else {
      Alert.alert('Error', 'Could not add item.')
    }
    setAdding(false)
  }

  async function removeItem(id: string) {
    const userId = userIdRef.current
    await supabase.from('grocery_items').update({ cleared: true }).eq('id', id)
    if (userId) await loadItemsSilent(userId)
  }

  async function clearAll() {
    if (items.length === 0) return
    Alert.alert('Clear All', 'Remove all items from your list?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear All',
        style: 'destructive',
        onPress: async () => {
          const userId = userIdRef.current
          if (!userId) return
          const ids = items.map(i => i.id)
          await supabase.from('grocery_items').update({ cleared: true }).in('id', ids)
          await loadItemsSilent(userId)
        },
      },
    ])
  }

  async function runRestock() {
    if (items.length === 0) return
    setCartReady(false)
    setAgentRunning(true)
    try {
      const { data, error } = await supabase.functions.invoke('trigger-shopping-agent', { body: {} })
      if (error || !data?.success) {
        Alert.alert('Error', error?.message ?? data?.error ?? 'Could not start Restock.')
        setAgentRunning(false)
        return
      }
      // Keep agentRunning = true — poll until cart appears (~2 min)
      startPollingForCart()
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not start.')
      setAgentRunning(false)
    }
  }

  async function generateFromAI() {
    const text = aiText.trim()
    if (!text) return
    const userId = userIdRef.current
    if (!userId) return

    setAiLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('expand-grocery-list', {
        body: { text },
      })
      if (error || !data) {
        Alert.alert('Error', error?.message ?? 'Could not generate list.')
        setAiLoading(false)
        return
      }
      // Expect data to be an array of { name, quantity } objects or string array
      const generatedItems: Array<{ name: string; quantity?: string }> =
        Array.isArray(data) ? data : data.items ?? []

      for (const item of generatedItems) {
        const name = typeof item === 'string' ? item : item.name
        const quantity = typeof item === 'string' ? '1' : (item.quantity ?? '1')
        if (name) {
          await supabase.from('grocery_items').insert({
            user_id: userId,
            name,
            quantity,
            notes: '',
            cleared: false,
          })
        }
      }

      await loadItemsSilent(userId)
      setAiText('')
      setAiModalVisible(false)
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not generate list.')
    }
    setAiLoading(false)
  }

  function renderItem({ item, index }: { item: GroceryItem; index: number }) {
    return (
      <View style={styles.itemCard}>
        <View style={styles.itemIndex}>
          <Text style={styles.itemIndexText}>{index + 1}</Text>
        </View>
        <View style={styles.itemInfo}>
          <Text style={styles.itemName}>{item.name}</Text>
          {item.quantity && item.quantity !== '1' && (
            <Text style={styles.itemQty}>Qty: {item.quantity}</Text>
          )}
        </View>
        <TouchableOpacity
          style={styles.removeBtn}
          onPress={() => removeItem(item.id)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close" size={16} color={colors.danger} />
        </TouchableOpacity>
      </View>
    )
  }

  function renderEmpty() {
    return (
      <View style={styles.emptyState}>
        <View style={styles.emptyIcon}>
          <Text style={styles.emptyEmoji}>🏠</Text>
        </View>
        <Text style={styles.emptyTitle}>Your restock list is empty</Text>
        <Text style={styles.emptySubtitle}>
          Add household items below, or tap ✨ to describe what you need.
        </Text>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>My List</Text>
            <Text style={styles.subtitle}>
              {items.length} household {items.length === 1 ? 'item' : 'items'}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {items.length > 0 && (
              <TouchableOpacity style={styles.clearAllBtn} onPress={clearAll}>
                <Text style={styles.clearAllText}>Clear all</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.aiBtn}
              onPress={() => setAiModalVisible(true)}
            >
              <Text style={styles.aiBtnText}>✨</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Agent status banners */}
        {agentRunning && (
          <View style={styles.agentBanner}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.agentBannerText}>Shopping on Amazon… (~2 min)</Text>
          </View>
        )}
        {cartReady && (
          <View style={[styles.agentBanner, styles.agentBannerReady]}>
            <Text style={styles.agentBannerText}>✅ Cart ready — check the Home tab</Text>
          </View>
        )}

        {/* Items list */}
        <FlatList
          data={items}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          ListEmptyComponent={loading ? null : renderEmpty}
          contentContainerStyle={[
            styles.listContent,
            items.length === 0 && styles.listContentEmpty,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          style={styles.flex}
        />

        {/* Bottom area: Run Restock + Add input */}
        <View style={styles.bottomArea}>
          {items.length > 0 && (
            <TouchableOpacity
              style={[styles.restockBtn, agentRunning && styles.restockBtnDisabled]}
              onPress={runRestock}
              disabled={agentRunning}
            >
              {agentRunning ? (
                <View style={styles.restockBtnRow}>
                  <ActivityIndicator color="#fff" size="small" style={{ marginRight: spacing.sm }} />
                  <Text style={styles.restockBtnText}>Shopping...</Text>
                </View>
              ) : (
                <Text style={styles.restockBtnText}>Run Restock</Text>
              )}
            </TouchableOpacity>
          )}

          {/* Add item input bar */}
          <View style={styles.inputBar}>
            <TextInput
              style={styles.itemInput}
              placeholder="Add an item..."
              placeholderTextColor={colors.textMuted}
              value={itemName}
              onChangeText={setItemName}
              onSubmitEditing={addItem}
              returnKeyType="done"
            />
            <TextInput
              style={styles.qtyInput}
              placeholder="Qty"
              placeholderTextColor={colors.textMuted}
              value={itemQty}
              onChangeText={setItemQty}
              keyboardType="numeric"
              returnKeyType="done"
              onSubmitEditing={addItem}
            />
            <TouchableOpacity
              style={[styles.addBtn, adding && styles.addBtnDisabled]}
              onPress={addItem}
              disabled={adding}
            >
              {adding ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Ionicons name="add" size={22} color="#fff" />
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* AI Expand Modal */}
      <Modal
        visible={aiModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAiModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          {/* Modal Header */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>✨ Ask Restock</Text>
            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setAiModalVisible(false)}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.modalBody}>
            <Text style={styles.modalLabel}>Describe what you need restocked:</Text>

            {/* Examples */}
            <View style={styles.examplesRow}>
              {['Paper towels and cleaning supplies', 'Office supplies', 'Bathroom essentials'].map(ex => (
                <TouchableOpacity
                  key={ex}
                  style={styles.exampleChip}
                  onPress={() => setAiText(ex)}
                >
                  <Text style={styles.exampleChipText}>{ex}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              style={styles.aiTextInput}
              placeholder="e.g. I need paper towels, dish soap, and laundry detergent"
              placeholderTextColor={colors.textMuted}
              value={aiText}
              onChangeText={setAiText}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
            />

            <TouchableOpacity
              style={[styles.generateBtn, aiLoading && styles.generateBtnDisabled]}
              onPress={generateFromAI}
              disabled={aiLoading}
            >
              {aiLoading ? (
                <View style={styles.restockBtnRow}>
                  <ActivityIndicator color="#fff" size="small" style={{ marginRight: spacing.sm }} />
                  <Text style={styles.generateBtnText}>Generating...</Text>
                </View>
              ) : (
                <Text style={styles.generateBtnText}>Generate List</Text>
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.background },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerLeft: { flex: 1 },
  title: {
    fontSize: font.size.xxl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  subtitle: {
    fontSize: font.size.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 4,
  },
  clearAllBtn: {
    backgroundColor: colors.dangerLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.full,
  },
  clearAllText: {
    fontSize: font.size.xs,
    color: colors.danger,
    fontWeight: '600',
  },
  aiBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.sm,
  },
  aiBtnText: { fontSize: 16 },

  // List
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  listContentEmpty: {
    flex: 1,
    justifyContent: 'center',
  },

  // Item card
  itemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadow.sm,
  },
  itemIndex: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemIndexText: {
    fontSize: font.size.sm,
    fontWeight: '700',
    color: colors.primary,
  },
  itemInfo: { flex: 1 },
  itemName: {
    fontSize: font.size.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  itemQty: {
    fontSize: font.size.xs,
    color: colors.textSecondary,
    marginTop: 2,
  },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.dangerLight,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  agentBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primaryLight,
    borderBottomWidth: 1,
    borderBottomColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
  },
  agentBannerReady: {
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderBottomColor: colors.success,
  },
  agentBannerText: {
    fontSize: font.size.sm,
    fontWeight: '600',
    color: colors.primary,
    flex: 1,
  },
  emptyEmoji: { fontSize: 28 },
  emptyTitle: {
    fontSize: font.size.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  emptySubtitle: {
    fontSize: font.size.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Bottom area
  bottomArea: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },

  // Run Restock button
  restockBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.md,
  },
  restockBtnDisabled: { opacity: 0.6 },
  restockBtnRow: { flexDirection: 'row', alignItems: 'center' },
  restockBtnText: {
    color: '#fff',
    fontSize: font.size.md,
    fontWeight: '700',
  },

  // Add input bar
  inputBar: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  itemInput: {
    flex: 1,
    backgroundColor: colors.cardMid,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: font.size.md,
    color: colors.textPrimary,
  },
  qtyInput: {
    width: 60,
    backgroundColor: colors.cardMid,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 12,
    fontSize: font.size.md,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  addBtn: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.sm,
  },
  addBtnDisabled: { opacity: 0.6 },

  // AI Modal
  modalContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: {
    fontSize: font.size.xl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  modalClose: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.cardMid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBody: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.md,
  },
  modalLabel: {
    fontSize: font.size.md,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  examplesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  exampleChip: {
    backgroundColor: colors.cardMid,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  exampleChipText: {
    fontSize: font.size.xs,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  aiTextInput: {
    backgroundColor: colors.cardMid,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: font.size.md,
    color: colors.textPrimary,
    minHeight: 120,
  },
  generateBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.md,
  },
  generateBtnDisabled: { opacity: 0.6 },
  generateBtnText: {
    color: '#fff',
    fontSize: font.size.md,
    fontWeight: '700',
  },
})
