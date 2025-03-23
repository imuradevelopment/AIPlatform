<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { supabase } from './lib/supabaseClient'
import { marked } from 'marked'

// ----- ステート管理 -----
// ユーザー/認証関連
const user = ref(null)
const authError = ref('')
const isLoading = ref(false)
const authInitialized = ref(false)
const auth = ref({ email: '', password: '' })

// コンテンツ管理
const categories = ref([])
const articles = ref([])
const selectedCategory = ref(null)
const selectedArticle = ref(null)
const isGenerating = ref(false)

// カテゴリ管理
const showAddCategory = ref(false)
const editingCategory = ref(null)
const categoryForm = ref({ name: '' })

// 通知関連
const isPushActive = ref(false)
const notificationBtnText = computed(() => 
  isPushActive.value ? '通知をキャンセル' : '通知を登録'
)

// ----- 追加するステート -----
// カテゴリフォロー管理
const allCategories = ref([]) // 全カテゴリ
const followedCategories = ref(new Set()) // フォロー中のカテゴリIDセット
const isFollowLoading = ref(false) // フォロー処理中フラグ
const showOnlyFollowed = ref(false) // フォロー中のみ表示フラグ

// ユーザープロフィール管理用
const username = ref('')

// 表示するカテゴリ（フィルター適用）
const displayCategories = computed(() => {
  if (!showOnlyFollowed.value) {
    return allCategories.value // 全カテゴリ
  } else {
    // フォロー中のカテゴリのみフィルター
    return allCategories.value.filter(cat => 
      followedCategories.value.has(cat.id)
    )
  }
})

// ----- アプリケーション初期化 -----
onMounted(async () => {
  // Service Worker登録
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      console.log('Service Worker登録成功')
    } catch (error) {
      console.error('Service Worker登録失敗:', error)
    }
  }

  // 認証状態変更リスナー
  supabase.auth.onAuthStateChange((event, session) => {
    // ユーザー状態を更新
    const previousUser = user.value
    user.value = session?.user || null
    
    // セッションがある場合の処理
    if (session) {
      // プロフィール確認・作成
      checkAndCreateProfile()
      
      // データ取得
      fetchCategories()
      fetchArticles()
      
      // 初期化未完了またはユーザーIDが変わった場合のみ通知同期実行
      if (!authInitialized.value || (previousUser?.id !== user.value?.id)) {
        syncPushSubscription()
      }
      
      // URLパラメータの記事IDを確認
      checkArticleInUrl()
    } else {
      // ログアウト時
      isPushActive.value = false
      followedCategories.value = new Set()
    }
    
    // 初期化完了をマーク
    authInitialized.value = true
  })

  // 初期認証状態チェック
  await supabase.auth.getSession()
})

// URLパラメータから記事IDを取得して表示
async function checkArticleInUrl() {
  // URLパラメータを解析
  const urlParams = new URLSearchParams(window.location.search)
  const articleId = urlParams.get('article')
  
  // 記事IDが存在し、ユーザーがログイン済みの場合
  if (articleId && user.value) {
    try {
      // 記事データを取得
      const { data: article } = await supabase
        .from('articles')
        .select('*')
        .eq('id', articleId)
        .single()
      
      if (article) {
        // 記事を表示
        selectedArticle.value = article
        
        // 記事のカテゴリを選択
        const { data: category } = await supabase
          .from('categories')
          .select('*')
          .eq('id', article.category_id)
          .single()
        
        if (category) {
          selectedCategory.value = category
          // 記事リストも更新
          fetchArticles(category.id)
        }
      }
    } catch (error) {
      console.error('記事取得エラー:', error)
    }
  }
}

// ----- ユーザープロフィール管理 -----
// プロフィール確認・作成
async function checkAndCreateProfile() {
  if (!user.value) return
  
  try {
    // プロフィール取得
    const { data: profile } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', user.value.id)
      .single()
    
    // プロフィールが存在する場合
    if (profile) {
      username.value = profile.username
      return
    }
    
    // プロフィールが存在しない場合は作成
    const emailName = user.value.email.split('@')[0]
    username.value = emailName
    
    await supabase
      .from('profiles')
      .insert({
        id: user.value.id,
        username: emailName
      })
  } catch (error) {
    console.error('プロフィール処理エラー:', error)
  }
}

// ----- 認証関連 -----
// ログイン処理
async function login() {
  try {
    isLoading.value = true
    authError.value = ''
    
    const { error } = await supabase.auth.signInWithPassword({
      email: auth.value.email,
      password: auth.value.password
    })
    
    if (error) throw error
  } catch (error) {
    authError.value = 'ログインに失敗しました: ' + error.message
  } finally {
    isLoading.value = false
  }
}

// 新規登録処理
async function register() {
  try {
    isLoading.value = true
    authError.value = ''
    
    const { error } = await supabase.auth.signUp({
      email: auth.value.email,
      password: auth.value.password
    })
    
    if (error) throw error
  } catch (error) {
    authError.value = '登録に失敗しました: ' + error.message
  } finally {
    isLoading.value = false
  }
}

// ログアウト処理
async function logout() {
  await supabase.auth.signOut()
  user.value = null
  categories.value = []
  articles.value = []
}

// ----- プッシュ通知管理 -----
// 通知状態の同期
async function syncPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !user.value) {
    isPushActive.value = false
    return
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const browserSubscription = await registration.pushManager.getSubscription()
    
    // ブラウザ側に購読情報がない場合
    if (!browserSubscription) {
      isPushActive.value = false
      return
    }
    
    // ブラウザのエンドポイント取得
    const browserEndpoint = browserSubscription.endpoint
    
    // 同じエンドポイントの購読情報をDBから検索
    const { data: existingSubscription, error: fetchError } = await supabase
      .from('push_subscriptions')
      .select('id, subscription_json')
      .eq('user_id', user.value.id)
      .eq('endpoint', browserEndpoint)
      .maybeSingle()
    
    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('購読情報取得エラー:', fetchError)
      isPushActive.value = false
      return
    }
    
    // DB側にも購読情報がある場合
    if (existingSubscription) {
      // エンドポイント比較（変更がなければスキップ）
      const dbSub = existingSubscription.subscription_json
      if (browserEndpoint === dbSub.endpoint) {
        console.log('既存の購読情報に変更なし')
      } else {
        // 更新が必要な場合
        const { error: updateError } = await supabase
          .from('push_subscriptions')
          .update({ subscription_json: browserSubscription })
          .eq('id', existingSubscription.id)
        
        if (updateError) {
          console.error('購読情報更新エラー:', updateError)
        }
      }
    } else {
      // 新規登録が必要な場合
      const { error: insertError } = await supabase
        .from('push_subscriptions')
        .insert({
          user_id: user.value.id,
          subscription_json: browserSubscription
        })
      
      if (insertError) {
        console.error('購読情報保存エラー:', insertError)
        isPushActive.value = false
        return
      }
    }
    
    // 登録確認と状態更新
    const { data: verifyData } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', user.value.id)
      .eq('endpoint', browserEndpoint)
    
    isPushActive.value = verifyData && verifyData.length > 0
  } catch (error) {
    console.error('通知同期エラー:', error)
    isPushActive.value = false
  }
}

// 通知購読状態の確認
async function checkPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !user.value) {
    isPushActive.value = false
    return
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    
    if (!subscription) {
      isPushActive.value = false
      return
    }
    
    const endpoint = subscription.endpoint
    
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', user.value.id)
      .eq('endpoint', endpoint)
    
    if (error) {
      console.error('DB購読状態確認エラー:', error)
      isPushActive.value = false
      return
    }
    
    isPushActive.value = data && data.length > 0
  } catch (error) {
    console.error('通知状態確認エラー:', error)
    isPushActive.value = false
  }
}

// 通知設定管理（切り替え）
async function toggleNotifications() {
  if (isPushActive.value) {
    await unsubscribeFromPush()
  } else {
    await subscribeToPush()
  }
}

// 購読解除処理
async function unsubscribeFromPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('お使いのブラウザはプッシュ通知をサポートしていません')
    return
  }
  
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    
    if (subscription) {
      // 購読解除
      await subscription.unsubscribe()
      
      // DBから購読情報削除
      await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', user.value.id)
        .eq('endpoint', subscription.endpoint)
      
      isPushActive.value = false
      alert('通知の登録を解除しました')
    }
  } catch (error) {
    console.error('通知解除エラー:', error)
    alert('通知の解除中にエラーが発生しました: ' + error.message)
  }
}

// 購読登録処理
async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('お使いのブラウザはプッシュ通知をサポートしていません')
    return
  }
  
  try {
    // 通知許可を要求
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      alert('通知の許可が必要です')
      return
    }
    
    // 既存の購読があれば解除
    const registration = await navigator.serviceWorker.ready
    const existingSubscription = await registration.pushManager.getSubscription()
    
    if (existingSubscription) {
      // 解除前にエンドポイントを保存
      const oldEndpoint = existingSubscription.endpoint
      
      // ブラウザから購読解除
      await existingSubscription.unsubscribe()
      
      // DBからも対応するエンドポイントの購読を削除
      await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', user.value.id)
        .eq('endpoint', oldEndpoint)
      
      // 解除後少し待機
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    
    // 新規購読の登録
    const newSubscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY)
    })
    
    // 登録確認
    if (!newSubscription) {
      throw new Error('購読登録に失敗しました')
    }
    
    // Supabaseに保存
    const { error: saveError } = await supabase
      .from('push_subscriptions')
      .insert({
        user_id: user.value.id,
        subscription_json: newSubscription
      })
    
    if (saveError) {
      throw saveError
    }
    
    // 登録状態を確認
    await checkPushSubscription()
    
    if (isPushActive.value) {
      alert('通知の設定が完了しました')
    } else {
      alert('通知の設定が完了しましたが、登録状態の確認ができませんでした')
    }
  } catch (error) {
    console.error('通知設定エラー:', error)
    alert('通知の設定中にエラーが発生しました: ' + error.message)
    isPushActive.value = false
  }
}

// プッシュ通知送信関数を修正
async function sendPushNotification(categoryId, title, articleId, body) {
  try {
    // カテゴリIDベースで通知送信
    const { error } = await supabase.functions.invoke('send-push', {
      body: {
        category_id: categoryId,
        title,
        article_id: articleId,
        body
      }
    })
    
    if (error) {
      console.error('通知送信エラー:', error)
    }
  } catch (error) {
    console.error('通知送信エラー:', error)
  }
}

// ----- カテゴリ管理（修正） -----
// カテゴリ一覧取得を修正
async function fetchCategories() {
  try {
    // 全カテゴリ取得
    const { data: categories } = await supabase
      .from('categories')
      .select('*')
      .order('created_at', { ascending: false })
    
    if (categories) {
      allCategories.value = categories
    }
    
    // 現在ユーザーがフォロー中のカテゴリを取得
    if (user.value) {
      const { data: follows } = await supabase
        .from('category_follows')
        .select('category_id')
        .eq('user_id', user.value.id)
      
      // フォロー中カテゴリIDをセットに変換
      followedCategories.value = new Set(follows?.map(f => f.category_id) || [])
    }
  } catch (error) {
    console.error('カテゴリ取得エラー:', error)
  }
}

// カテゴリ選択
function selectCategory(category) {
  selectedCategory.value = category
  fetchArticles(category.id)
}

// カテゴリ編集
function editCategory(category) {
  editingCategory.value = category
  categoryForm.value = {
    name: category.name
  }
  showAddCategory.value = true
}

// カテゴリ削除
async function deleteCategory(id) {
  if (!confirm('このカテゴリを削除しますか？関連する記事もすべて削除されます。')) return
  
  await supabase.from('categories').delete().eq('id', id)
  fetchCategories()
  
  if (selectedCategory.value?.id === id) {
    selectedCategory.value = null
    articles.value = []
  }
}

// カテゴリ追加/編集フォームを閉じる
function closeAddCategory() {
  showAddCategory.value = false
  editingCategory.value = null
  categoryForm.value = { name: '' }
}

// カテゴリ保存（修正：creator_nameを追加）
async function saveCategory() {
  try {
    let categoryId = null
    
    if (editingCategory.value) {
      // 更新（自分のカテゴリのみ）
      await supabase
        .from('categories')
        .update({
          name: categoryForm.value.name
        })
        .eq('id', editingCategory.value.id)
        .eq('user_id', user.value.id)
      
      categoryId = editingCategory.value.id
    } else {
      // 新規作成
      const { data, error } = await supabase
        .from('categories')
        .insert({
          name: categoryForm.value.name,
          user_id: user.value.id,
          creator_name: username.value // ユーザー名を保存
        })
        .select()
        .single()
      
      if (error) throw error
      categoryId = data.id
    }
    
    // 新規カテゴリ作成時は自動フォロー
    if (!editingCategory.value && categoryId) {
      await followCategory(categoryId)
    }
    
    closeAddCategory()
    fetchCategories()
  } catch (error) {
    console.error('カテゴリ保存エラー:', error)
    alert('カテゴリの保存中にエラーが発生しました')
  }
}

// ----- カテゴリフォロー管理 -----
// カテゴリフォロー
async function followCategory(categoryId) {
  if (!user.value || isFollowLoading.value) return
  
  try {
    isFollowLoading.value = true
    
    const { error } = await supabase
      .from('category_follows')
      .insert({
        user_id: user.value.id,
        category_id: categoryId
      })
    
    if (error) throw error
    
    // フォロー状態更新
    followedCategories.value.add(categoryId)
  } catch (error) {
    console.error('フォローエラー:', error)
    alert('カテゴリのフォローに失敗しました')
  } finally {
    isFollowLoading.value = false
  }
}

// カテゴリアンフォロー
async function unfollowCategory(categoryId) {
  if (!user.value || isFollowLoading.value) return
  
  try {
    isFollowLoading.value = true
    
    const { error } = await supabase
      .from('category_follows')
      .delete()
      .eq('user_id', user.value.id)
      .eq('category_id', categoryId)
    
    if (error) throw error
    
    // フォロー状態更新
    followedCategories.value.delete(categoryId)
  } catch (error) {
    console.error('アンフォローエラー:', error)
    alert('カテゴリのフォロー解除に失敗しました')
  } finally {
    isFollowLoading.value = false
  }
}

// フォロー状態確認
function isFollowing(categoryId) {
  return followedCategories.value.has(categoryId)
}

// フォロー切り替え
async function toggleFollow(categoryId) {
  if (isFollowing(categoryId)) {
    await unfollowCategory(categoryId)
  } else {
    await followCategory(categoryId)
  }
}

// ----- 記事管理 -----
// 記事一覧取得
async function fetchArticles(categoryId = null) {
  let query = supabase.from('articles').select('*')
  
  if (categoryId) {
    query = query.eq('category_id', categoryId)
  } else if (selectedCategory.value) {
    query = query.eq('category_id', selectedCategory.value.id)
  }
  
  const { data } = await query.order('created_at', { ascending: false })
  
  if (data) articles.value = data
}

// 記事生成
async function generateArticle() {
  if (!selectedCategory.value) return
  
  try {
    isGenerating.value = true
    
    // 現在の日付を取得
    const today = new Date()
    const formattedDate = today.toISOString().split('T')[0]
    
    // Gemini APIでのリクエスト（Google検索を強制使用）
    const response = await fetch(import.meta.env.VITE_GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{
              text: `あなたは最新情報を提供するAIアシスタントです。すべての質問に対して、まず「${selectedCategory.value.name}」に関する過去24時間（${formattedDate}現在）の最新情報をgoogle_searchツールを使用してGoogle検索を行ってください。その検索結果に基づいてのみ、回答を生成してください。検索結果が見つからなかった場合は、次のJSON形式で返してください：{\"has_news\": false}。検索結果があった場合は、その情報に基づいて、複数記事を含む以下の形式のJSONで回答してください。検索結果に存在しないURLや情報は絶対に含めないでください。：
              {
                "has_news": true または false,
                "articles": [
                  {
                    "title": "記事のタイトル",
                    "content": "記事の内容（500文字程度）",
                    "source_url": "参考URL",
                    "push_title": "プッシュ通知用のタイトル（50文字以内）",
                    "push_body": "プッシュ通知の内容（100文字以内）"
                  },
                  ...（複数記事がある場合）
                ]
              }
              
              検索結果が見つからなかった場合は {"has_news": false} のみを返してください。`
            }]
          }
        ],
        tools: [
          { google_search: {} }
        ],
        tool_config: {
          function_calling_config: {
            mode: "ANY",
            allowed_function_names: ["google_search"]
          }
        },
        generationConfig: {
          temperature: 0.0,
          candidate_count: 1,
          top_p: 0.8,
          top_k: 40
        }
      })
    })
    
    // ステータスコードの確認
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`APIエラー: HTTP ${response.status}`, errorText)
      throw new Error(`APIリクエストが失敗しました: HTTP ${response.status}: ${errorText}`)
    }
    
    const data = await response.json()
    
    // レスポンスの処理
    if (!data.candidates || data.candidates.length === 0) {
      console.error('APIレスポンス詳細:', JSON.stringify(data))
      throw new Error('APIレスポンスが不正です')
    }
    
    const generatedContent = data.candidates[0].content.parts[0].text
    
    // JSONをパースして処理
    let articleData
    try {
      // テキストからJSONを抽出
      const jsonMatch = generatedContent.match(/{[\s\S]*}/m)
      if (jsonMatch) {
        articleData = JSON.parse(jsonMatch[0])
      } else {
        console.error('JSON抽出エラー - レスポンステキスト:', generatedContent)
        throw new Error('JSONデータが見つかりません')
      }
    } catch (parseError) {
      console.error('JSON解析エラー:', parseError)
      console.error('解析失敗テキスト:', generatedContent)
      throw new Error('JSONの解析に失敗しました: ' + parseError.message)
    }
    
    // 記事が存在するか確認
    if (!articleData.has_news) {
      alert(`${selectedCategory.value.name}に関する最新の情報は見つかりませんでした`)
      isGenerating.value = false
      return
    }
    
    // 各記事をDBに保存して通知送信
    for (const article of articleData.articles) {
      // 記事保存
      const { data: savedArticle, error: saveError } = await supabase
        .from('articles')
        .insert({
          title: article.title,
          content: article.content + (article.source_url ? `\n\n参考: [${article.source_url}](${article.source_url})` : ''),
          category_id: selectedCategory.value.id
        })
        .select()
        .single()
      
      if (saveError) {
        console.error('記事保存エラー:', saveError)
        continue
      }
      
      // 通知送信
      await sendPushNotification(
        selectedCategory.value.id, 
        article.push_title || article.title, 
        savedArticle.id,
        article.push_body || article.content
      )
    }
    
    // 記事リスト更新
    fetchArticles(selectedCategory.value.id)
    alert(`${articleData.articles.length}件の記事を生成しました`)
  } catch (error) {
    console.error('記事生成エラー:', error)
    alert('記事の生成中にエラーが発生しました: ' + error.message)
  } finally {
    isGenerating.value = false
  }
}

// 記事表示
function viewArticle(article) {
  // 同じ記事をクリックした場合は表示を切り替え
  if (selectedArticle.value?.id === article.id) {
    selectedArticle.value = null;
  } else {
    selectedArticle.value = article;
  }
}

// ----- ユーティリティ関数 -----
// 日付フォーマット
function formatDate(dateString) {
  return new Date(dateString).toLocaleString('ja-JP')
}

// Markdown処理
function formatContent(content) {
  return marked(content)
}

// Base64からUint8Arrayへの変換（VAPID用）
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
</script>

<template>
  <div class="min-h-screen bg-background text-text">
    <!-- 未ログイン時の認証フォーム -->
    <div v-if="!user" class="flex justify-center items-center min-h-screen">
      <div class="glass-card w-full max-w-md">
        <h1 class="text-2xl font-bold text-heading mb-4">AIPlatform</h1>
        <!-- 認証フォーム -->
        <div>
          <div class="mb-4">
            <label class="block mb-1">メールアドレス</label>
            <input 
              v-model="auth.email" 
              type="email" 
              class="w-full bg-surface-variant p-2 rounded" 
              required
            />
          </div>
          <div class="mb-4">
            <label class="block mb-1">パスワード</label>
            <input 
              v-model="auth.password" 
              type="password" 
              class="w-full bg-surface-variant p-2 rounded" 
              required
            />
          </div>
          <div class="flex flex-col gap-2">
            <button 
              @click="login" 
              class="btn-primary"
              :disabled="isLoading"
            >
              ログイン
            </button>
            <button 
              @click="register" 
              class="btn-outline-primary"
              :disabled="isLoading"
            >
              新規登録
            </button>
          </div>
          <p v-if="authError" class="mt-4 text-error text-sm">{{ authError }}</p>
        </div>
      </div>
    </div>

    <!-- ログイン後のメイン画面 -->
    <div v-else class="container mx-auto p-4">
      <!-- ヘッダー -->
      <header class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold text-heading">AIPlatform</h1>
        <div class="flex items-center gap-4">
          <button 
            class="btn-link" 
            @click="toggleNotifications"
            :class="{ 'text-primary': !isPushActive, 'text-error': isPushActive }"
          >
            {{ notificationBtnText }}
          </button>
          <button class="btn-outline-primary" @click="logout">ログアウト</button>
        </div>
      </header>

      <!-- メインコンテンツエリア -->
      <div class="flex flex-col lg:flex-row gap-6">
        <!-- カテゴリーセクション（修正） -->
        <div class="w-full lg:w-1/3">
          <div class="glass-card">
            <div class="flex justify-between items-center mb-4">
              <h2 class="text-xl font-bold text-heading">カテゴリ</h2>
              <button class="btn-icon-primary" @click="showAddCategory = true">
                <span>+</span>
              </button>
            </div>
            
            <!-- カテゴリ表示タブ -->
            <div class="flex mb-4 border-b border-surface-accent">
              <button 
                class="px-3 py-1 mr-2"
                :class="{'border-b-2 border-primary font-bold': !showOnlyFollowed}"
                @click="showOnlyFollowed = false"
              >
                すべて
              </button>
              <button 
                class="px-3 py-1"
                :class="{'border-b-2 border-primary font-bold': showOnlyFollowed}"
                @click="showOnlyFollowed = true"
              >
                フォロー中
              </button>
            </div>
            
            <!-- カテゴリ一覧（フィルターに対応） -->
            <div class="space-y-2">
              <div
                v-for="category in displayCategories"
                :key="category.id"
                class="p-2 rounded hover:bg-surface-accent"
              >
                <div class="flex justify-between items-center mb-1"
                     :class="{ 'bg-surface-accent': selectedCategory?.id === category.id }"
                     @click="selectCategory(category)">
                  <span>{{ category.name }}</span>
                  <div class="flex gap-2">
                    <!-- 自分のカテゴリのみ編集/削除可能 -->
                    <template v-if="category.user_id === user.id">
                      <button class="btn-icon-sm btn-icon-secondary" @click.stop="editCategory(category)">編集</button>
                      <button class="btn-icon-sm btn-icon-error" @click.stop="deleteCategory(category.id)">削除</button>
                    </template>
                  </div>
                </div>
                
                <!-- カテゴリ情報とフォローボタン -->
                <div class="flex justify-end items-center text-sm text-text-muted mt-1">
                  <button 
                    class="btn-sm"
                    :class="isFollowing(category.id) ? 'btn-error' : 'btn-primary'"
                    :disabled="isFollowLoading"
                    @click.stop="toggleFollow(category.id)"
                  >
                    {{ isFollowing(category.id) ? 'フォロー解除' : 'フォロー' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 記事セクション -->
        <div class="w-full lg:w-2/3">
          <div class="glass-card mb-4 flex justify-between items-center">
            <h2 class="text-xl font-bold text-heading">
              {{ selectedCategory ? selectedCategory.name + 'の記事' : '記事一覧' }}
            </h2>
            <button
              v-if="selectedCategory"
              class="btn-primary"
              :disabled="isGenerating"
              @click="generateArticle"
            >
              {{ isGenerating ? '生成中...' : '記事を生成' }}
            </button>
          </div>

          <!-- 記事リスト -->
          <div class="space-y-4">
            <div v-if="articles.length === 0" class="text-center py-8 text-text-muted">
              記事がありません。カテゴリを選択して記事を生成してください。
            </div>
            <div
              v-for="article in articles"
              :key="article.id"
              class="glass-card"
            >
              <div class="cursor-pointer" @click="viewArticle(article)">
                <h3 class="text-lg font-bold text-heading mb-2">{{ article.title }}</h3>
                <p class="text-sm text-text-muted">{{ formatDate(article.created_at) }}</p>
              </div>
              
              <!-- 記事内容（クリックした記事のみ表示） -->
              <div v-if="selectedArticle && selectedArticle.id === article.id" class="mt-4 border-t border-surface-accent pt-4">
                <div class="flex justify-between items-center mb-4">
                  <h2 class="text-xl font-bold text-heading">{{ selectedArticle.title }}</h2>
                  <button class="btn-icon-error" @click="selectedArticle = null">✕</button>
                </div>
                <div class="prose prose-invert max-w-none">
                  <!-- 記事内容をMarkdownとして表示 -->
                  <div v-html="formatContent(selectedArticle.content)"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- モーダル: カテゴリ追加/編集 -->
    <div v-if="showAddCategory" class="fixed inset-0 bg-background/80 flex items-center justify-center">
      <div class="glass-card w-full max-w-md">
        <h2 class="text-xl font-bold text-heading mb-4">
          {{ editingCategory ? 'カテゴリを編集' : 'カテゴリを追加' }}
        </h2>
        <form @submit.prevent="saveCategory">
          <div class="mb-4">
            <label class="block mb-1">名前</label>
            <input
              v-model="categoryForm.name"
              class="w-full bg-surface-variant p-2 rounded"
              required
            />
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn-outline-secondary" @click="closeAddCategory">
              キャンセル
            </button>
            <button type="submit" class="btn-primary">保存</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>


