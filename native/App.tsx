import { useEffect, useRef, useState } from 'react'
import * as Google from 'expo-auth-session/providers/google'
import WebView from 'react-native-webview'
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
} from 'firebase/auth'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import 'expo-dev-client'
import CookieManager from '@react-native-cookies/cookies'
import {
  AUTH_COOKIE_NAME,
  ENV_CONFIG,
  FIREBASE_CONFIG,
} from 'common/envs/constants'
import {
  doc,
  getFirestore,
  getDoc,
  updateDoc,
  deleteField,
} from 'firebase/firestore'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { Text, View, Button, Platform } from 'react-native'
import { Notification } from 'expo-notifications'
import { Subscription } from 'expo-modules-core'
import { TEN_YEARS_SECS } from 'common/envs/constants'
import { PrivateUser } from 'common/user'
import { setFirebaseUserViaJson } from 'common/firebase-auth'
import { getApp, getApps, initializeApp } from 'firebase/app'
import { removeUndefinedProps } from 'common/util/object'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
})
const isExpoClient =
  Constants.ExecutionEnvironment === ExecutionEnvironment.StoreClient

// Initialize Firebase
console.log('using', process.env.NEXT_PUBLIC_FIREBASE_ENV, 'env')
console.log('env not switching? run `expo start --clear` and then try again')
const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG)
const firestore = getFirestore(app)
const auth = getAuth(app)

// no other uri works for API requests due to CORS
// const uri = 'http://localhost:3000/'
const uri = 'https://88ad-181-41-206-31.ngrok.io'

export default function App() {
  const [fbUser, setFbUser] = useState<string | null>()
  const [privateUser, setPrivateUser] = useState<string | null>()
  const [_, response, promptAsync] = Google.useIdTokenAuthRequest(
    ENV_CONFIG.expoConfig
  )
  const webview = useRef<WebView>()
  const [hasInjectedVariable, setHasInjectedVariable] = useState(false)
  const useWebKit = true
  const [notification, setNotification] = useState<Notification | false>(false)
  const notificationListener = useRef<Subscription | undefined>()
  const responseListener = useRef<Subscription | undefined>()

  useEffect(() => {
    // This listener is fired whenever a notification is received while the app is foregrounded
    notificationListener.current =
      Notifications.addNotificationReceivedListener((notification) => {
        // TODO: pass this to the webview so we can navigate to the correct page
        setNotification(notification)
      })

    // This listener is fired whenever a user taps on or interacts with a notification (works when app is foregrounded, backgrounded, or killed)
    responseListener.current =
      Notifications.addNotificationResponseReceivedListener((response) => {
        console.log(response)
      })

    return () => {
      Notifications.removeNotificationSubscription(notificationListener.current)
      Notifications.removeNotificationSubscription(responseListener.current)
    }
  }, [])

  // We can't just log in to google within the webview: see https://developers.googleblog.com/2021/06/upcoming-security-changes-to-googles-oauth-2.0-authorization-endpoint.html#instructions-ios
  useEffect(() => {
    if (response?.type === 'success') {
      const { id_token } = response.params
      const credential = GoogleAuthProvider.credential(id_token)
      signInWithCredential(auth, credential).then((result) => {
        const fbUser = result.user.toJSON()
        if (webview.current) {
          webview.current.postMessage(
            JSON.stringify({ type: 'nativeFbUser', data: fbUser })
          )
        }
      })
    }
  }, [response])

  useEffect(() => {
    console.log('is expo client:', isExpoClient)
    if (fbUser) {
      !isExpoClient &&
        CookieManager.set(
          uri,
          {
            name: AUTH_COOKIE_NAME,
            value: encodeURIComponent(fbUser),
            path: '/',
            expires: new Date(TEN_YEARS_SECS).toISOString(),
            secure: true,
          },
          useWebKit
        )
    }
  }, [])

  const setPushToken = async (userId: string, pushToken: string) => {
    console.log('setting push token', pushToken)
    const userDoc = doc(firestore, 'private-users', userId)
    const privateUserDoc = (await getDoc(userDoc)).data() as PrivateUser
    await updateDoc(
      doc(firestore, 'private-users', userId),
      removeUndefinedProps({
        ...privateUserDoc,
        pushToken,
        rejectedPushNotificationsOn: privateUserDoc.rejectedPushNotificationsOn
          ? deleteField()
          : undefined,
      })
    )
  }

  const setPushTokenRequestDenied = async (userId: string) => {
    console.log('push token denied', userId)
    const userDoc = doc(firestore, 'private-users', userId)
    const privateUserDoc = (await getDoc(userDoc)).data() as PrivateUser
    await updateDoc(doc(firestore, 'private-users', userId), {
      ...privateUserDoc,
      rejectedPushNotificationsOn: Date.now(),
    })
  }

  const registerForPushNotificationsAsync = async () => {
    if (Device.isDevice) {
      const { status: existingStatus } =
        await Notifications.getPermissionsAsync()
      let finalStatus = existingStatus
      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync()
        finalStatus = status
      }
      if (finalStatus !== 'granted' && privateUser) {
        setPushTokenRequestDenied(JSON.parse(privateUser).id)
        return
      }
      const appConfig = require('./app.json')
      const projectId = appConfig?.expo?.extra?.eas?.projectId
      const token = (
        await Notifications.getExpoPushTokenAsync({
          projectId,
        })
      ).data
      console.log(token)
      return token
    } else {
      alert('Must use physical device for Push Notifications')
    }

    if (Platform.OS === 'android') {
      Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
      })
    }

    return null
  }

  const handleMessageFromWebview = ({ nativeEvent }) => {
    // Time to log in to firebase
    if (nativeEvent.data === 'googleLoginClicked') {
      promptAsync()
      return
    }
    // User needs to enable push notifications
    else if (
      nativeEvent.data === 'promptEnablePushNotifications' &&
      privateUser
    ) {
      const privateUserObj = JSON.parse(privateUser) as PrivateUser
      if (!privateUserObj?.pushToken) {
        registerForPushNotificationsAsync().then((token) => {
          token && setPushToken(privateUserObj.id, token)
        })
      }
      return
    } else if (nativeEvent.data === 'signOut') {
      console.log('signOut called')
      auth.signOut()
      setFbUser(null)
      setPrivateUser(null)
      !isExpoClient && CookieManager.clearAll(useWebKit)
      return
    }
    try {
      const fbUserAndPrivateUser = JSON.parse(nativeEvent.data)
      // Passing us a signed-in user object
      if (
        fbUserAndPrivateUser &&
        fbUserAndPrivateUser.fbUser &&
        fbUserAndPrivateUser.privateUser
      ) {
        console.log('Signing in fb user from webview cache')
        setFirebaseUserViaJson(fbUserAndPrivateUser.fbUser, app)
        setFbUser(JSON.stringify(fbUserAndPrivateUser.fbUser))
        setPrivateUser(JSON.stringify(fbUserAndPrivateUser.privateUser))
        return
      }
    } catch (e) {
      // Not a user object
      console.log('Unhandled nativeEvent.data: ', nativeEvent.data)
    }
  }

  return (
    <>
      <WebView
        style={{ marginTop: 20, marginBottom: 15 }}
        allowsBackForwardNavigationGestures={true}
        sharedCookiesEnabled={true}
        source={{ uri }}
        ref={webview}
        onMessage={handleMessageFromWebview}
        onNavigationStateChange={async (navState) => {
          if (!navState.loading && !hasInjectedVariable && webview.current) {
            webview.current.injectJavaScript('window.isNative = true')
            setHasInjectedVariable(true)
          }
        }}
      />

      {/*{!fbUser && (*/}
      {/*  <View*/}
      {/*    style={{*/}
      {/*      alignItems: 'center',*/}
      {/*      width: 400,*/}
      {/*      height: 200,*/}
      {/*      marginTop: 40,*/}
      {/*    }}*/}
      {/*  >*/}
      {/*    <Button*/}
      {/*      disabled={!request}*/}
      {/*      title="Login"*/}
      {/*      color={'black'}*/}
      {/*      onPress={() => {*/}
      {/*        promptAsync()*/}
      {/*      }}*/}
      {/*    />*/}
      {/*  </View>*/}
      {/*)}*/}
    </>
  )
}
