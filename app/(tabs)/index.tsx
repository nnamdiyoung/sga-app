import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, SafeAreaView, KeyboardAvoidingView, Platform,
  Alert, Animated
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font, shadow } from '../../lib/theme'
import type { GroceryItem } from '../../lib/types'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function GroceryList() {
  const [items, setItems] = useState<GroceryItem[]>([])
  const [input, setInput] = useState('')
  const [quantity, setQuantity] = useState('')
  const [loading, setLoading] = useState(true)
  const [nextShop, setNextShop] = useState<string | null>(null)
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    fetchItems()
    fetchNextShop()
  }, [])

  async function fetchItems() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase
      .from('grocery_items')
      .select('*')
      .eq('user_id', user.id)
      .eq('cleared', false)
      .order('added_at', { ascending: false })
    setItems(data ?? [])
    setLoading(false)
  }

  async function fetchNextShop() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase
      .from('schedules')
      .select('days, time, active')
      .eq('user_id', user.id)
      .single()
    if (!data || !data.active || !data.days?.length) return

    const now = new Date()
    const currentDay = now.getDay()
    const sortedDays = [...data.days].sort((a, b) => a - b)
    const next = sortedDays.find(d => d > currentDay) ?? sortedDays[0]
    const daysUntil = next > currentDay ? next - currentDay : 7 - currentDay + next
    const nextDate = new Date(now)
    nextDate.setDate(now.getDate() + daysUntil)
    const [h] = (data.time ?? '09:00').split(':')
    const hour = parseInt(h)
    const timeStr = hour === 0 ? '12:00 AM' : hour < 12 ? `${hour}:00 AM` : hour === 12 ? '12:00 PM' : `${hour - 12}:00 PM`
    setNextShop(`${DAYS[next]} ${nextDate.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} at ${timeStr}`)
  }

  async function addItem() {
    const name = input.trim()
    if (!name) return
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const newItem = {
      user_id: user.id,
      name,
      quantity: quantity.trim() || '1',
      notes: '',
      cleared: false,
    }

    const { data } = await supabase.from('grocery_items').insert(newItem).select().single()
    if (data) setItems(prev => [data, ...prev])
    setInput('')
    setQuantity('')
    inputRef.current?.focus()
  }

  async function removeItem(id: string) {
    await supabase.from('grocery_items').update({ cleared: true }).eq('id', id)
    setItems(prev => prev.filter(i => i.id !== id))
  }

  async function clearAll() {
    Alert.alert('Clear List', 'Remove all items from your list?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear', style: 'destructive',
        onPress: async () => {
          const { data: { user } } = await supabase.auth.getUser()
          if (!user) return
          await supabase.from('grocery_items').update({ cleared: true }).eq('user_id', user.id).eq('cleared', false)
          setItems([])
        }
      }
    ])
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>My List</Text>
          {nextShop && (
            <View style={styles.nextShopBadge}>
              <Ionicons name="time-outline" size={12} color={colors.primary} />
              <Text style={styles.nextShopText}>SGA shops {nextShop}</Text>
            </View>
          )}
        </View>
        {items.length > 0 && (
          <TouchableOpacity onPress={clearAll} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear all</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{items.length}</Text>
          <Text style={styles.statLabel}>Items</Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.primaryLight }]}>
          <Ionicons name="sparkles" size={18} color={colors.primary} />
          <Text style={[styles.statLabel, { color: colors.primary }]}>AI Ready</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={90}
      >
        <FlatList
          data={items}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            !loading ? (
              <View style={styles.empty}>
                <View style={styles.emptyIconWrap}>
                  <Text style={styles.emptyIcon}>🛍️</Text>
                </View>
                <Text style={styles.emptyTitle}>Your list is empty</Text>
                <Text style={styles.emptyText}>
                  Add items below. SGA will find the best matches and build your cart automatically.
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item, index }) => (
            <View style={[styles.item, { opacity: 1 }]}>
              <View style={styles.itemLeft}>
                <View style={styles.itemIndex}>
                  <Text style={styles.itemIndexText}>{index + 1}</Text>
                </View>
                <View style={styles.itemText}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  {item.quantity !== '1' && (
                    <Text style={styles.itemQty}>Qty: {item.quantity}</Text>
                  )}
                </View>
              </View>
              <TouchableOpacity onPress={() => removeItem(item.id)} style={styles.removeBtn}>
                <Ionicons name="close" size={14} color={colors.danger} />
              </TouchableOpacity>
            </View>
          )}
        />

        <View style={styles.inputArea}>
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.itemInput}
              value={input}
              onChangeText={setInput}
              placeholder="Add an item..."
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={addItem}
              returnKeyType="done"
            />
            <TextInput
              style={styles.qtyInput}
              value={quantity}
              onChangeText={setQuantity}
              placeholder="Qty"
              placeholderTextColor={colors.textMuted}
            />
            <TouchableOpacity style={styles.addBtn} onPress={addItem}>
              <Ionicons name="add" size={24} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  title: {
    fontSize: font.size.xxl,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  nextShopBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  nextShopText: {
    fontSize: font.size.xs,
    color: colors.primary,
    fontWeight: '600',
  },
  clearBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: colors.dangerLight,
  },
  clearBtnText: { fontSize: font.size.sm, color: colors.danger, fontWeight: '600' },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    gap: 2,
    ...shadow.sm,
  },
  statNumber: {
    fontSize: font.size.xl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  statLabel: {
    fontSize: font.size.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  empty: {
    alignItems: 'center',
    paddingTop: spacing.xxl * 1.5,
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyIcon: { fontSize: 36 },
  emptyTitle: {
    fontSize: font.size.lg,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  emptyText: {
    fontSize: font.size.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    ...shadow.sm,
  },
  itemLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  itemIndex: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemIndexText: { fontSize: font.size.xs, fontWeight: '700', color: colors.primary },
  itemText: { flex: 1 },
  itemName: { fontSize: font.size.md, color: colors.textPrimary, fontWeight: '600' },
  itemQty: { fontSize: font.size.xs, color: colors.textSecondary, marginTop: 2 },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.dangerLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputArea: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    ...shadow.md,
  },
  inputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  itemInput: {
    flex: 1,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: font.size.md,
    color: colors.textPrimary,
  },
  qtyInput: {
    width: 56,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 12,
    fontSize: font.size.sm,
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
})
