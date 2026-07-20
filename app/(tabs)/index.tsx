import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, SafeAreaView, KeyboardAvoidingView, Platform, Alert
} from 'react-native'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font } from '../../lib/theme'
import type { GroceryItem } from '../../lib/types'

export default function GroceryList() {
  const [items, setItems] = useState<GroceryItem[]>([])
  const [input, setInput] = useState('')
  const [quantity, setQuantity] = useState('')
  const [loading, setLoading] = useState(true)
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    fetchItems()
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
          <Text style={styles.subtitle}>{items.length} item{items.length !== 1 ? 's' : ''}</Text>
        </View>
        {items.length > 0 && (
          <TouchableOpacity onPress={clearAll} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear all</Text>
          </TouchableOpacity>
        )}
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
          ListEmptyComponent={
            !loading ? (
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>🛍️</Text>
                <Text style={styles.emptyTitle}>Your list is empty</Text>
                <Text style={styles.emptyText}>Add items below and SGA will shop for you on your next scheduled run.</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={styles.item}>
              <View style={styles.itemLeft}>
                <View style={styles.bullet} />
                <View>
                  <Text style={styles.itemName}>{item.name}</Text>
                  {item.quantity !== '1' && (
                    <Text style={styles.itemQty}>Qty: {item.quantity}</Text>
                  )}
                </View>
              </View>
              <TouchableOpacity onPress={() => removeItem(item.id)} style={styles.removeBtn}>
                <Text style={styles.removeBtnText}>✕</Text>
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
              keyboardType="default"
            />
            <TouchableOpacity style={styles.addBtn} onPress={addItem}>
              <Text style={styles.addBtnText}>+</Text>
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
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: { fontSize: font.size.xxl, fontWeight: '800', color: colors.textPrimary },
  subtitle: { fontSize: font.size.sm, color: colors.textSecondary, marginTop: 2 },
  clearBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  clearBtnText: { fontSize: font.size.sm, color: colors.textSecondary },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  empty: { alignItems: 'center', paddingTop: spacing.xxl * 2, paddingHorizontal: spacing.xl },
  emptyIcon: { fontSize: 48, marginBottom: spacing.md },
  emptyTitle: { fontSize: font.size.lg, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.sm },
  emptyText: { fontSize: font.size.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  bullet: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  itemName: { fontSize: font.size.md, color: colors.textPrimary, fontWeight: '500' },
  itemQty: { fontSize: font.size.xs, color: colors.textSecondary, marginTop: 2 },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.dangerLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: { fontSize: font.size.xs, color: colors.danger, fontWeight: '700' },
  inputArea: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
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
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: { color: '#fff', fontSize: 24, fontWeight: '300', lineHeight: 28 },
})
