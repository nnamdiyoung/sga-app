import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, SafeAreaView, Alert, Modal, ActivityIndicator
} from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { WebView } from 'react-native-webview'
import type { WebView as WebViewType } from 'react-native-webview'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font } from '../../lib/theme'

const DIETARY_OPTIONS = ['Vegetarian', 'Vegan', 'Halal', 'Kosher', 'Gluten-Free', 'Dairy-Free', 'Nut-Free']

import { INSTACART_STORES } from '../../lib/stores'

const CAPTURE_SESSION_JS = `
  (function() {
    try {
      var ls = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k) ls[k] = localStorage.getItem(k);
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({
        cookies: document.cookie,
        localStorage: ls
      }));
    } catch(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ error: String(e) }));
    }
  })();
  true;
`

export default function Profile() {
  const { connect } = useLocalSearchParams<{ connect?: string }>()
  const [budget, setBudget] = useState('')
  const [dietary, setDietary] = useState<string[]>([])
  const [allergyInput, setAllergyInput] = useState('')
  const [allergies, setAllergies] = useState<string[]>([])
  const [brandInput, setBrandInput] = useState('')
  const [brands, setBrands] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [preferredStore, setPreferredStore] = useState('')
  const [instacartConnected, setInstacartConnected] = useState(false)
  const [showWebView, setShowWebView] = useState(false)
  const [webViewReady, setWebViewReady] = useState(false)
  const [capturingSession, setCapturingSession] = useState(false)
  const webViewRef = useRef<WebViewType>(null)
  const capturedRef = useRef(false)

  useEffect(() => {
    loadProfile()
  }, [])

  useEffect(() => {
    if (connect === '1') openInstacartConnect()
  }, [connect])

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
      setPreferredStore(data.preferred_store_slug ?? '')
      setInstacartConnected(!!data.instacart_session)
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
      preferred_store_slug: preferredStore,
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

  function openInstacartConnect() {
    capturedRef.current = false
    setWebViewReady(false)
    setCapturingSession(false)
    setShowWebView(true)
  }

  function handleWebViewNavigation(navState: { url: string }) {
    const url = navState.url || ''
    // User has left the login/oauth pages — they're logged in
    const isLoggedIn =
      url.includes('instacart.ca') &&
      !url.includes('/login') &&
      !url.includes('accounts.google.com') &&
      !url.includes('appleid.apple.com') &&
      !url.includes('facebook.com')

    if (isLoggedIn && webViewReady && !capturedRef.current) {
      capturedRef.current = true
      setCapturingSession(true)
      webViewRef.current?.injectJavaScript(CAPTURE_SESSION_JS)
    }
  }

  async function handleWebViewMessage(event: { nativeEvent: { data: string } }) {
    try {
      const data = JSON.parse(event.nativeEvent.data)
      if (data.error) {
        setCapturingSession(false)
        Alert.alert('Error', 'Could not capture session. Please try again.')
        return
      }

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const sessionJson = JSON.stringify({
        cookies: data.cookies ?? '',
        localStorage: data.localStorage ?? {},
      })

      const updatePayload = { instacart_session: sessionJson }
      if (profileId) {
        await supabase.from('profiles').update(updatePayload).eq('id', profileId)
      } else {
        await supabase.from('profiles').upsert({ user_id: user.id, ...updatePayload })
      }

      setInstacartConnected(true)
      setCapturingSession(false)
      setShowWebView(false)
      Alert.alert('Connected!', 'Your Instacart account is now linked. The agent will use it for your next shopping run.')
    } catch {
      setCapturingSession(false)
      Alert.alert('Error', 'Failed to save session. Please try again.')
    }
  }

  async function disconnectInstacart() {
    Alert.alert('Disconnect Instacart', 'Remove your Instacart session?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          if (profileId) {
            await supabase.from('profiles').update({ instacart_session: '' }).eq('id', profileId)
          }
          setInstacartConnected(false)
        }
      }
    ])
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
          <Text style={styles.cardTitle}>Preferred Store</Text>
          <Text style={styles.cardSubtitle}>SGA will shop from this store on Instacart</Text>
          <View style={styles.tagsWrap}>
            {INSTACART_STORES.map(store => (
              <TouchableOpacity
                key={store.slug}
                style={[styles.tag, preferredStore === store.slug && styles.tagActive]}
                onPress={() => setPreferredStore(store.slug)}
              >
                <Text style={[styles.tagText, preferredStore === store.slug && styles.tagTextActive]}>
                  {store.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {!preferredStore && (
            <Text style={styles.secureNote}>Pick your store so the agent searches in the right place</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Instacart Account</Text>
          <Text style={styles.cardSubtitle}>Connect your account so the AI agent can shop on your behalf</Text>
          {instacartConnected ? (
            <View style={styles.connectedRow}>
              <View style={styles.connectedBadge}>
                <View style={styles.connectedDot} />
                <Text style={styles.connectedText}>Connected</Text>
              </View>
              <TouchableOpacity onPress={disconnectInstacart}>
                <Text style={styles.disconnectText}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.connectBtn} onPress={openInstacartConnect}>
              <Text style={styles.connectBtnText}>Connect Instacart Account</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.secureNote}>Your session is encrypted and only used by the shopping agent</Text>
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

      <Modal visible={showWebView} animationType="slide" presentationStyle="fullScreen">
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>Connect Instacart</Text>
              <Text style={styles.modalSubtitle}>Log in with your Instacart account</Text>
            </View>
            <TouchableOpacity
              style={styles.modalCloseBtn}
              onPress={() => setShowWebView(false)}
            >
              <Text style={styles.modalCloseBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {capturingSession && (
            <View style={styles.capturingOverlay}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.capturingText}>Saving your session...</Text>
            </View>
          )}

          <WebView
            ref={webViewRef}
            source={{ uri: 'https://www.instacart.ca/login' }}
            style={styles.webView}
            onLoad={() => setWebViewReady(true)}
            onNavigationStateChange={handleWebViewNavigation}
            onMessage={handleWebViewMessage}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
          />
        </SafeAreaView>
      </Modal>
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
  connectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  connectedBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  connectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  connectedText: { fontSize: font.size.sm, fontWeight: '600', color: colors.primary },
  disconnectText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '500' },
  connectBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  connectBtnText: { color: '#fff', fontWeight: '700', fontSize: font.size.sm },
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
  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  modalTitle: { fontSize: font.size.md, fontWeight: '700', color: colors.textPrimary },
  modalSubtitle: { fontSize: font.size.xs, color: colors.textSecondary, marginTop: 2 },
  modalCloseBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalCloseBtnText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '600' },
  webView: { flex: 1 },
  capturingOverlay: {
    position: 'absolute',
    top: 80,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.9)',
    zIndex: 10,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  capturingText: { fontSize: font.size.md, color: colors.textPrimary, fontWeight: '600' },
})
