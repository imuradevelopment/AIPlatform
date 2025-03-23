// FCMデバッグモードを有効化
self.FCM_DEBUG = true;

// Service Workerのインストール時
self.addEventListener('install', (event) => {
  console.log('Service Worker: インストール中');
  self.skipWaiting(); // 即座にアクティブ化
});

// Service Workerのアクティベーション時
self.addEventListener('activate', (event) => {
  console.log('Service Worker: アクティブ化完了');
  event.waitUntil(clients.claim()); // コントロール権を取得
});

// デバッグ用: Fetchイベントを監視して活性状態を確認
self.addEventListener('fetch', (event) => {
  // 特定のリクエストを監視（頻繁なログを避けるため）
  if (event.request.url.includes('debug=sw')) {
    console.log('Fetch イベント:', event.request.url);
  }
});

// サブスクリプション変更イベント
self.addEventListener('pushsubscriptionchange', (event) => {
  console.log('プッシュ購読変更イベント発生');
  
  // 変更状態をメインスレッドに通知
  self.clients.matchAll().then(clients => {
    if (clients && clients.length) {
      clients.forEach(client => {
        client.postMessage({
          type: 'SUBSCRIPTION_CHANGE',
          oldSubscription: event.oldSubscription,
          newSubscription: event.newSubscription
        });
      });
    }
  });
});

// プッシュイベント処理
self.addEventListener('push', (event) => {
  // デフォルト通知内容
  let title = 'お知らせ';
  let options = {
    body: '新しい記事が生成されました',
    icon: '/icon.png',
    timestamp: Date.now(),
    tag: 'article-notification-' + Date.now(), // 必ず一意のタグを使用
    renotify: true
  };

  // データ処理とプッシュ通知表示を行う
  const showNotification = async () => {
    try {
      // プッシュデータがあれば解析
      if (event.data) {
        try {
          // データログ追加
          console.log('受信したプッシュデータ:', event.data);
          const rawText = event.data.text();
          console.log('プッシュデータのテキスト:', rawText);
          
          // JSON文字列のクリーニングと正規化
          let cleanedText = rawText;
          
          // 方法1: 正規表現で有効なJSON部分のみを抽出
          try {
            const jsonMatch = rawText.match(/(\{.*\})/s);
            if (jsonMatch) {
              cleanedText = jsonMatch[0];
            }
          } catch (regexError) {
            console.log('正規表現抽出エラー:', regexError);
          }
          
          // 方法2: 制御文字と不可視文字を除去
          cleanedText = cleanedText
            .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // 制御文字を削除
            .replace(/\uFFFD/g, '') // 置換文字を削除
            .replace(/[\uD800-\uDFFF]/g, ''); // サロゲートペアの不完全な部分を削除
          
          console.log('クリーニング後のJSON:', cleanedText);
          
          // パースを試行
          const data = JSON.parse(cleanedText);
          
          // 通知データの設定
          if (data.title) title = data.title;
          if (data.body) options.body = data.body;
          if (data.icon) options.icon = data.icon;
          
          // データオブジェクト処理
          if (data.data) {
            options.data = data.data;
            
            // article_idがある場合はタグを設定
            if (data.data.article_id) {
              options.tag = `article-${data.data.article_id}-${Date.now()}`;
            }
          }
        } catch (e) {
          console.log('データ解析エラー、デフォルト通知を使用します');
          console.log('解析エラーの詳細:', e);
        }
      }
      
      // 通知を直接表示（キューなし）
      return self.registration.showNotification(title, options);
    } catch (error) {
      console.error('通知表示エラー:', error);
      
      // エラー時は1秒待ってからもう一度試行
      await new Promise(resolve => setTimeout(resolve, 1000));
      return self.registration.showNotification(title, options);
    }
  };

  // 通知処理を待機
  event.waitUntil(showNotification());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  // デフォルトのURLパス
  let url = '/';
  
  // 通知に記事IDがある場合は、その記事ページへのURLを設定
  if (event.notification.data && event.notification.data.article_id) {
    const articleId = event.notification.data.article_id;
    url = `/?article=${articleId}`;
  }
  
  event.waitUntil(clients.openWindow(url));
}); 