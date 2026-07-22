import { useState, useEffect } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, SafeAreaView, Alert
} from 'react-native'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font } from '../../lib/theme'

const HOUSEHOLD_OPTIONS = [
  'Eco-Friendly',
  'Fragrance-Free',
  'Hypoallergenic',
  'Bulk Buy',
  'Premium Brands',
  'Budget-Friendly',
  'Unscented',
  'Natural/Organic',
]

const HOUSEHOLD_SIZES = ['1', '2', '3', '4', '5+']

export default function Profile() {
  const [budget, setBudget] = useState('')
  const [householdSize, setHouseholdSize] = useState(2)
  const [preferences, setPreferences] = useState<string[]>([])
  const [avoidInput, setAvoidInput] = useState('')
  const [avoidList, setAvoidList] = useState<string[]>([])
  const [brandInput, setBrandInput] = useState('')
  const [brands, setBrands] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [email, setEmail] = useState('')

  useEffect(() => {
    loadProfile()
  }, [])

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    setEmail(user.email ?? '')

    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (data) {
      setProfileId(data.id)
      setBudget(String(data.budget ?? ''))
      setPreferences(data.dietary ?? [])
      setAvoidList(data.allergies ?? [])
      setBrands(data.brands ?? [])
    }
  }

  function togglePreference(option: string) {
    setPreferences(prev =>
      prev.includes(option) ? prev.filter(p => p !== option) : [...prev, option]
    )
  }

  function addAvoid() {
    const val = avoidInput.trim()
    if (val && !avoidList.includes(val)) {
      setAvoidList(prev => [...prev, val])
      setAvoidInput('')
    }
  }

  function removeAvoid(item: string) {
    setAvoidList(prev => prev.filter(x => x !== item))
  }

  function addBrand() {
    const val = brandInput.trim()
    if (val && !brands.includes(val)) {
      setBrands(prev => [...prev, val])
      setBrandInput('')
    }
  }

  function removeBrand(brand: string) {
    setBrands(prev => prev.filter(x => x !== brand))
  }

  async function saveProfile() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    setSaving(true)

    const payload = {
      user_id: user.id,
      budget: parseFloat(budget) || 0,
      dietary: preferences,
      allergies: avoidList,
      brands,
    }

    if (profileId) {
      await supabase.from('profiles').update(payload).eq('id', profileId)
    } else {
      const { data } = await supabase.from('profiles').insert(payload).select().single()
      if (data) setProfileId(data.id)
    }

    setSaving(false)
    Alert.alert('Saved', 'Your profile has been updated.')
  }

  async function handleSignOut() {
    Alert.alert('Sign Out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => supabase.auth.signOut() }
    ])
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Profile</Text>
          <Text style={styles.subtitle}>{email}</Text>
        </View>

        {/* Budget */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Monthly Budget</Text>
          <Text style={styles.cardSubtitle}>Restock will stay under this amount per shop</Text>
          <View style={styles.budgetRow}>
            <Text style={styles.currencySymbol}>$</Text>
            <TextInput
              style={styles.budgetInput}
              value={budget}
              onChangeText={setBudget}
              placeholder="200"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
            />
            <Text style={styles.currencyCode}>CAD</Text>
          </View>
        </View>

        {/* Household Size */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Household Size</Text>
          <Text style={styles.cardSubtitle}>How many people in your home?</Text>
          <View style={styles.sizeRow}>
            {HOUSEHOLD_SIZES.map((size, idx) => {
              const sizeNum = idx + 1
              const isActive = householdSize === sizeNum
              return (
                <TouchableOpacity
                  key={size}
                  style={[styles.sizeBtn, isActive && styles.sizeBtnActive]}
                  onPress={() => setHouseholdSize(sizeNum)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.sizeBtnText, isActive && styles.sizeBtnTextActive]}>
                    {size}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </View>

        {/* Household Preferences */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Household Preferences</Text>
          <Text style={styles.cardSubtitle}>Restock will prioritize products that match</Text>
          <View style={styles.tagsWrap}>
            {HOUSEHOLD_OPTIONS.map(opt => {
              const isActive = preferences.includes(opt)
              return (
                <TouchableOpacity
                  key={opt}
                  style={[styles.chip, isActive && styles.chipActive]}
                  onPress={() => togglePreference(opt)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.chipText, isActive && styles.chipTextActive]}>{opt}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </View>

        {/* Avoid */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Avoid</Text>
          <Text style={styles.cardSubtitle}>Restock will avoid products containing these</Text>
          {avoidList.length > 0 && (
            <View style={styles.tagsWrap}>
              {avoidList.map(item => (
                <TouchableOpacity
                  key={item}
                  style={styles.chipDanger}
                  onPress={() => removeAvoid(item)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.chipDangerText}>{item} ✕</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.inlineInput}
              value={avoidInput}
              onChangeText={setAvoidInput}
              placeholder="e.g. peanuts, latex"
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={addAvoid}
              returnKeyType="done"
            />
            <TouchableOpacity style={styles.addBtn} onPress={addAvoid}>
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Preferred Brands */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Preferred Brands</Text>
          <Text style={styles.cardSubtitle}>Restock will prioritize these brands when available</Text>
          {brands.length > 0 && (
            <View style={styles.tagsWrap}>
              {brands.map(brand => (
                <TouchableOpacity
                  key={brand}
                  style={styles.chipBrand}
                  onPress={() => removeBrand(brand)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.chipBrandText}>{brand} ✕</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.inlineInput}
              value={brandInput}
              onChangeText={setBrandInput}
              placeholder="e.g. President's Choice"
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={addBrand}
              returnKeyType="done"
            />
            <TouchableOpacity style={styles.addBtn} onPress={addBrand}>
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Save */}
        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={saveProfile}
          disabled={saving}
          activeOpacity={0.85}
        >
          <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save Profile'}</Text>
        </TouchableOpacity>

        {/* Sign Out */}
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={handleSignOut}
          activeOpacity={0.75}
        >
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },

  header: { marginBottom: spacing.xs },
  title: { fontSize: font.size.xxl, fontWeight: '800', color: colors.textPrimary },
  subtitle: { fontSize: font.size.sm, color: colors.textSecondary, marginTop: 2 },

  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: font.size.md, fontWeight: '700', color: colors.textPrimary },
  cardSubtitle: { fontSize: font.size.sm, color: colors.textSecondary },

  // Budget
  budgetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  currencySymbol: { fontSize: font.size.xl, fontWeight: '700', color: colors.textPrimary },
  budgetInput: {
    flex: 1,
    fontSize: font.size.xl,
    fontWeight: '700',
    color: colors.primary,
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
    paddingBottom: 4,
  },
  currencyCode: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '600' },

  // Household Size
  sizeRow: { flexDirection: 'row', gap: spacing.sm },
  sizeBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardMid,
    alignItems: 'center',
  },
  sizeBtnActive: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primary,
  },
  sizeBtnText: {
    fontSize: font.size.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  sizeBtnTextActive: { color: colors.primary },

  // Chips (preferences)
  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardMid,
  },
  chipActive: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primary,
  },
  chipText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: colors.primary, fontWeight: '600' },

  // Danger chips (Avoid)
  chipDanger: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerLight,
  },
  chipDangerText: { fontSize: font.size.sm, color: colors.danger, fontWeight: '500' },

  // Brand chips
  chipBrand: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  chipBrandText: { fontSize: font.size.sm, color: colors.primary, fontWeight: '500' },

  // Input row
  inputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  inlineInput: {
    flex: 1,
    backgroundColor: colors.cardMid,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: font.size.sm,
    color: colors.textPrimary,
  },
  addBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: font.size.sm },

  // Save
  saveBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontSize: font.size.md, fontWeight: '700' },

  // Sign Out
  signOutBtn: {
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  signOutText: { fontSize: font.size.md, color: colors.textSecondary, fontWeight: '600' },
})
