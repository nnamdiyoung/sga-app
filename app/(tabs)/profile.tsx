import { useState, useEffect } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, SafeAreaView, Alert, Switch
} from 'react-native'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font } from '../../lib/theme'

const DIETARY_OPTIONS = ['Vegetarian', 'Vegan', 'Halal', 'Kosher', 'Gluten-Free', 'Dairy-Free', 'Nut-Free']

export default function Profile() {
  const [budget, setBudget] = useState('')
  const [dietary, setDietary] = useState<string[]>([])
  const [allergyInput, setAllergyInput] = useState('')
  const [allergies, setAllergies] = useState<string[]>([])
  const [brandInput, setBrandInput] = useState('')
  const [brands, setBrands] = useState<string[]>([])
  const [instacartEmail, setInstacartEmail] = useState('')
  const [instacartPassword, setInstacartPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
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
      setDietary(data.dietary ?? [])
      setAllergies(data.allergies ?? [])
      setBrands(data.brands ?? [])
      setInstacartEmail(data.instacart_email ?? '')
      setInstacartPassword(data.instacart_password ?? '')
    }
  }

  function toggleDietary(option: string) {
    setDietary(prev => prev.includes(option) ? prev.filter(d => d !== option) : [...prev, option])
  }

  function addAllergy() {
    const val = allergyInput.trim()
    if (val && !allergies.includes(val)) {
      setAllergies(prev => [...prev, val])
      setAllergyInput('')
    }
  }

  function addBrand() {
    const val = brandInput.trim()
    if (val && !brands.includes(val)) {
      setBrands(prev => [...prev, val])
      setBrandInput('')
    }
  }

  async function saveProfile() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    setSaving(true)

    const payload = {
      user_id: user.id,
      budget: parseFloat(budget) || 0,
      dietary,
      allergies,
      brands,
      instacart_email: instacartEmail,
      instacart_password: instacartPassword,
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
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Profile</Text>
          <Text style={styles.subtitle}>{email}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Weekly Budget</Text>
          <Text style={styles.cardSubtitle}>SGA will stay under this amount per shop</Text>
          <View style={styles.budgetRow}>
            <Text style={styles.currencySymbol}>$</Text>
            <TextInput
              style={styles.budgetInput}
              value={budget}
              onChangeText={setBudget}
              placeholder="150"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
            />
            <Text style={styles.currencyCode}>CAD</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Dietary Preferences</Text>
          <Text style={styles.cardSubtitle}>SGA will only pick products that match</Text>
          <View style={styles.tagsWrap}>
            {DIETARY_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt}
                style={[styles.tag, dietary.includes(opt) && styles.tagActive]}
                onPress={() => toggleDietary(opt)}
              >
                <Text style={[styles.tagText, dietary.includes(opt) && styles.tagTextActive]}>{opt}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Allergies</Text>
          <Text style={styles.cardSubtitle}>SGA will avoid products containing these</Text>
          <View style={styles.tagsWrap}>
            {allergies.map(a => (
              <TouchableOpacity
                key={a}
                style={[styles.tag, styles.tagDanger]}
                onPress={() => setAllergies(prev => prev.filter(x => x !== a))}
              >
                <Text style={styles.tagDangerText}>{a} ✕</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.inlineInput}
              value={allergyInput}
              onChangeText={setAllergyInput}
              placeholder="e.g. peanuts"
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={addAllergy}
              returnKeyType="done"
            />
            <TouchableOpacity style={styles.addTagBtn} onPress={addAllergy}>
              <Text style={styles.addTagBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Favourite Brands</Text>
          <Text style={styles.cardSubtitle}>SGA will prefer these when available</Text>
          <View style={styles.tagsWrap}>
            {brands.map(b => (
              <TouchableOpacity
                key={b}
                style={[styles.tag, styles.tagGreen]}
                onPress={() => setBrands(prev => prev.filter(x => x !== b))}
              >
                <Text style={styles.tagGreenText}>{b} ✕</Text>
              </TouchableOpacity>
            ))}
          </View>
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
            <TouchableOpacity style={styles.addTagBtn} onPress={addBrand}>
              <Text style={styles.addTagBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Instacart Account</Text>
          <Text style={styles.cardSubtitle}>Used by the AI agent to shop on your behalf</Text>
          <TextInput
            style={styles.input}
            value={instacartEmail}
            onChangeText={setInstacartEmail}
            placeholder="Instacart email"
            placeholderTextColor={colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={instacartPassword}
              onChangeText={setInstacartPassword}
              placeholder="Instacart password"
              placeholderTextColor={colors.textMuted}
              secureTextEntry={!showPassword}
            />
            <TouchableOpacity onPress={() => setShowPassword(p => !p)} style={styles.showBtn}>
              <Text style={styles.showBtnText}>{showPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.secureNote}>🔒 Stored securely and only used for automated shopping</Text>
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={saveProfile}
          disabled={saving}
        >
          <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save Profile'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  header: { marginBottom: spacing.sm },
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
  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tag: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  tagActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tagText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '500' },
  tagTextActive: { color: '#fff', fontWeight: '600' },
  tagDanger: { backgroundColor: colors.dangerLight, borderColor: colors.danger },
  tagDangerText: { fontSize: font.size.sm, color: colors.danger, fontWeight: '500' },
  tagGreen: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  tagGreenText: { fontSize: font.size.sm, color: colors.primary, fontWeight: '500' },
  inputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  inlineInput: {
    flex: 1,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: font.size.sm,
    color: colors.textPrimary,
  },
  addTagBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  addTagBtnText: { color: '#fff', fontWeight: '600', fontSize: font.size.sm },
  input: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: font.size.sm,
    color: colors.textPrimary,
  },
  passwordRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  showBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  showBtnText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '600' },
  secureNote: { fontSize: font.size.xs, color: colors.textMuted },
  saveBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontSize: font.size.md, fontWeight: '700' },
  signOutBtn: {
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.xl,
  },
  signOutText: { fontSize: font.size.md, color: colors.textSecondary, fontWeight: '600' },
})
