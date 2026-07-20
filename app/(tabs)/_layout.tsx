import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '../../lib/theme'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']

function icon(focused: boolean, active: IoniconsName, inactive: IoniconsName) {
  return (
    <Ionicons
      name={focused ? active : inactive}
      size={24}
      color={focused ? colors.primary : colors.textMuted}
    />
  )
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 72,
          paddingBottom: 12,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'List',
          tabBarIcon: ({ focused }) => icon(focused, 'list', 'list-outline'),
        }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: 'Cart',
          tabBarIcon: ({ focused }) => icon(focused, 'cart', 'cart-outline'),
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Schedule',
          tabBarIcon: ({ focused }) => icon(focused, 'calendar', 'calendar-outline'),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => icon(focused, 'person', 'person-outline'),
        }}
      />
    </Tabs>
  )
}
