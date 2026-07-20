import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, TouchableOpacity, StyleSheet,
  SafeAreaView, ScrollView, Switch, Alert, ActivityIndicator
} from 'react-native'
import { supabase } from '../../lib/supabase'
import { colors, spacing, radius, font } from '../../lib/theme'
import { INSTACART_STORES, storeLabel } from '../../lib/stores'
import { useFocusEffect } from '@react-navigation/native'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const REMINDER_OPTIONS = [
  { label: '1 hour before', value: 1 },
  { label: '2 hours before', value: 2 },
  { label: '1 day before', value: 24 },
]

export default function Schedule() {
  const [selectedDays, setSelectedDays] = useState<number[]>([0])
  const [hour, setHour] = useState(9)
  const [reminderEnabled, setReminderEnabled] = useState(true)
  const [reminderHours, setReminderHours] = useState(1)
  const [active, setActive] = useState(true)
  const [saving, setSaving] = useState(false)
  const [scheduleId, setScheduleId] = useState<string | null>(null)
  const [shopping, setShopping] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [cartReady, setCartReady] = useState(false)
  const [pickingStore, setPickingStore] = useState(false)
  const [selectedStore, setSelectedStore] = useState('')
  const [runningStoreName, setRunningStoreName] = useState('')

  useEffect(() => {
    loadSchedule()
  }, [])

  useFocusEffect(useCallback(() => {
    return () => {
      // Reset Shop Now state when user leaves the tab
      setCartReady(false)
      setAgentRunning(false)
      setPickingStore(false)
      setSelectedStore('')
      setRunningStoreName('')
    }
  }, []))

  async function loadSchedule() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from('schedules').select('*').eq('user_id', user.id).single()
    if (data) {
      setScheduleId(data.id)
      setSelectedDays(data.days ?? [0])
      setHour(parseInt(data.time?.split(':')[0] ?? '9'))
      setReminderEnabled(data.reminder_enabled ?? true)
      setReminderHours(data.reminder_hours_before ?? 1)
      setActive(data.active ?? true)
    }
  }

  async function confirmShopNow() {
    if (!selectedStore) {
      Alert.alert('Pick a store', 'Select which store to shop from.')
      return
    }
    setShopping(true)
    setPickingStore(false)
    try {
      const { data, error } = await supabase.functions.invoke('trigger-shopping-agent', {
        body: { store_slug: selectedStore },
      })
      if (error) {
        Alert.alert('Error', error.message ?? 'Could not start shopping.')
        setPickingStore(true)
        setShopping(false)
        return
      }
      if (!data?.success) {
        Alert.alert('Error', data?.error ?? 'Could not start shopping.')
        setPickingStore(true)
        setShopping(false)
        return
      }
      setRunningStoreName(storeLabel(selectedStore))
      setAgentRunning(true)
      setCartReady(false)
      startWatchingForCart()
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not start shopping.')
      setPickingStore(true)
    }
    setShopping(false)
  }

function startWatchingForCart() {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      const channel = supabase
        .channel('schedule-cart-watch')
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'carts',
        }, (payload) => {
          if (payload.new.user_id === user.id) {
            setAgentRunning(false)
            setCartReady(true)
            channel.unsubscribe()
          }
        })
        .subscribe()
    })
  }

  function toggleDay(day: number) {
    setSelectedDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    )
  }

  function formatHour(h: number) {
    if (h === 0) return '12:00 AM'
    if (h < 12) return `${h}:00 AM`
    if (h === 12) return '12:00 PM'
    return `${h - 12}:00 PM`
  }

  async function saveSchedule() {
    if (selectedDays.length === 0) return Alert.alert('Select at least one day')
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const payload = {
      user_id: user.id,
      days: selectedDays,
      time: `${String(hour).padStart(2, '0')}:00`,
      reminder_enabled: reminderEnabled,
      reminder_hours_before: reminderHours,
      active,
    }

    if (scheduleId) {
      await supabase.from('schedules').update(payload).eq('id', scheduleId)
    } else {
      const { data } = await supabase.from('schedules').insert(payload).select().single()
      if (data) setScheduleId(data.id)
    }

    setSaving(false)
    Alert.alert('Saved', 'Your shopping schedule has been updated.')
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Schedule</Text>
          <Text style={styles.subtitle}>When should SGA shop for you?</Text>
        </View>

        <View style={[styles.card, styles.shopNowCard]}>
          {cartReady ? (
            <>
              <Text style={styles.shopNowTitle}>✅ Cart is ready!</Text>
              <Text style={styles.shopNowSub}>Go to the Cart tab to review and add to Instacart</Text>
            </>
          ) : agentRunning ? (
            <View style={styles.shopNowRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.shopNowTitle}>⏳ Shopping at {runningStoreName}...</Text>
                <Text style={styles.shopNowSub}>Finding best products (~2 min)</Text>
              </View>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : pickingStore ? (
            <>
              <Text style={styles.shopNowTitle}>Where should SGA shop?</Text>
              <View style={styles.storeGrid}>
                {INSTACART_STORES.map(store => (
                  <TouchableOpacity
                    key={store.slug}
                    style={[styles.storeBtn, selectedStore === store.slug && styles.storeBtnActive]}
                    onPress={() => setSelectedStore(store.slug)}
                  >
                    <Text style={[styles.storeBtnText, selectedStore === store.slug && styles.storeBtnTextActive]}>
                      {store.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.shopNowRow}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setPickingStore(false)}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.shopNowBtn, { flex: 1 }, (!selectedStore || shopping) && styles.shopNowBtnDisabled]}
                  onPress={confirmShopNow}
                  disabled={!selectedStore || shopping}
                >
                  <Text style={styles.shopNowBtnText}>{shopping ? 'Starting...' : 'Start Shopping'}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={styles.shopNowRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.shopNowTitle}>Shop Now</Text>
                <Text style={styles.shopNowSub}>Run SGA immediately, skipping the schedule</Text>
              </View>
              <TouchableOpacity style={styles.shopNowBtn} onPress={() => setPickingStore(true)}>
                <Text style={styles.shopNowBtnText}>Shop Now</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Shopping Days</Text>
          </View>
          <View style={styles.daysRow}>
            {DAYS.map((day, i) => (
              <TouchableOpacity
                key={day}
                style={[styles.dayBtn, selectedDays.includes(i) && styles.dayBtnActive]}
                onPress={() => toggleDay(i)}
              >
                <Text style={[styles.dayBtnText, selectedDays.includes(i) && styles.dayBtnTextActive]}>
                  {day}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Shopping Time</Text>
          <Text style={styles.selectedTime}>{formatHour(hour)}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.timeScroll}>
            <View style={styles.timeRow}>
              {HOURS.map(h => (
                <TouchableOpacity
                  key={h}
                  style={[styles.timeBtn, hour === h && styles.timeBtnActive]}
                  onPress={() => setHour(h)}
                >
                  <Text style={[styles.timeBtnText, hour === h && styles.timeBtnTextActive]}>
                    {formatHour(h)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Reminders</Text>
              <Text style={styles.cardSubtitle}>Get notified before SGA shops</Text>
            </View>
            <Switch
              value={reminderEnabled}
              onValueChange={setReminderEnabled}
              trackColor={{ true: colors.primary }}
            />
          </View>

          {reminderEnabled && (
            <View style={styles.reminderOptions}>
              {REMINDER_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.reminderBtn, reminderHours === opt.value && styles.reminderBtnActive]}
                  onPress={() => setReminderHours(opt.value)}
                >
                  <Text style={[styles.reminderBtnText, reminderHours === opt.value && styles.reminderBtnTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Schedule Active</Text>
              <Text style={styles.cardSubtitle}>Pause without deleting your schedule</Text>
            </View>
            <Switch
              value={active}
              onValueChange={setActive}
              trackColor={{ true: colors.primary }}
            />
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={saveSchedule}
          disabled={saving}
        >
          <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save Schedule'}</Text>
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
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: font.size.md, fontWeight: '700', color: colors.textPrimary },
  cardSubtitle: { fontSize: font.size.sm, color: colors.textSecondary, marginTop: 2 },
  daysRow: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },
  dayBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  dayBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayBtnText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '600' },
  dayBtnTextActive: { color: '#fff' },
  selectedTime: { fontSize: font.size.xl, fontWeight: '700', color: colors.primary },
  timeScroll: { marginHorizontal: -spacing.md },
  timeRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  timeBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  timeBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  timeBtnText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '500' },
  timeBtnTextActive: { color: '#fff', fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center' },
  reminderOptions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.xs },
  reminderBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  reminderBtnActive: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  reminderBtnText: { fontSize: font.size.sm, color: colors.textSecondary },
  reminderBtnTextActive: { color: colors.primary, fontWeight: '600' },
  saveBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontSize: font.size.md, fontWeight: '700' },
  shopNowCard: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primary,
  },
  shopNowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  shopNowTitle: { fontSize: font.size.md, fontWeight: '700', color: colors.primary },
  shopNowSub: { fontSize: font.size.xs, color: colors.textSecondary, marginTop: 2 },
  shopNowBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  shopNowBtnDisabled: { opacity: 0.5 },
  shopNowBtnText: { color: '#fff', fontWeight: '700', fontSize: font.size.sm },
  storeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  storeBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  storeBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  storeBtnText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '500' },
  storeBtnTextActive: { color: '#fff', fontWeight: '700' },
  cancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnText: { fontSize: font.size.sm, color: colors.textSecondary, fontWeight: '600' },
})
