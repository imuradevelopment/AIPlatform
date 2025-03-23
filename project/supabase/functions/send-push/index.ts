import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import * as jose from 'https://deno.land/x/jose@v4.14.4/index.ts'

console.log("エッジ関数起動: 低レベルWebPush実装");

// VAPID検証用の公開鍵をBase64からバイナリに変換
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// P-256点の検証（改善版）
async function validateP256Point(key: Uint8Array): Promise<boolean> {
  try {
    if (key.length !== 65 || key[0] !== 0x04) {
      console.error("無効な公開鍵形式:", { length: key.length, firstByte: key[0] });
      return false;
    }

    // WebCrypto APIを使用して鍵をインポート
    const result = await crypto.subtle.importKey(
      'raw',
      key,
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      true,
      []
    ).then(() => true)
    .catch(error => {
      console.error("鍵のインポートに失敗:", error);
      return false;
    });

    return result;
  } catch (error) {
    console.error("P-256点の検証エラー:", error);
    return false;
  }
}

// WebPush用のペイロード暗号化処理
async function encryptPayload(subscription: any, payload: string): Promise<Uint8Array> {
  if (!subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    throw new Error('購読オブジェクトに必要な暗号化キーがありません');
  }

  try {
    // クライアントの公開鍵と認証情報
    let clientPublicKey = urlBase64ToUint8Array(subscription.keys.p256dh);
    const clientAuth = urlBase64ToUint8Array(subscription.keys.auth);
    
    console.log("クライアント鍵情報:", {
      length: clientPublicKey.length,
      firstByte: clientPublicKey[0],
      isUncompressed: clientPublicKey[0] === 0x04
    });

    // クライアント鍵の検証と修正
    if (clientPublicKey.length === 64) {
      const fixedKey = new Uint8Array(65);
      fixedKey[0] = 0x04;
      fixedKey.set(clientPublicKey, 1);
      clientPublicKey = fixedKey;
      console.log("クライアント鍵を65バイトに変換しました");
    } else if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 0x04) {
      throw new Error(`無効なクライアント公開鍵形式: 長さ=${clientPublicKey.length}, 先頭バイト=${clientPublicKey[0]}`);
    }

    // サーバーのECDHキーペア生成
    const serverKeyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      true,
      ['deriveKey', 'deriveBits']
    );

    // サーバー公開鍵をエクスポート（非圧縮形式）
    const serverPublicKeyBuffer = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);
    const serverPublicKeyBytes = new Uint8Array(serverPublicKeyBuffer);

    console.log("サーバー鍵情報:", {
      length: serverPublicKeyBytes.length,
      firstByte: serverPublicKeyBytes[0],
      isUncompressed: serverPublicKeyBytes[0] === 0x04
    });

    // クライアント公開鍵のインポート
    const clientPublicKeyObj = await crypto.subtle.importKey(
      'raw',
      clientPublicKey,
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      true,
      []
    );

    // 共有秘密の生成
    const sharedSecretBuffer = await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: clientPublicKeyObj
      },
      serverKeyPair.privateKey,
      256
    );

    // TextEncoderのインスタンス化
    const encoder = new TextEncoder();

    // RFC 8188に準拠したキー導出
    const authInfo = encoder.encode("WebPush: info\0");
    const keyInfo = new Uint8Array(authInfo.length + clientPublicKey.length + serverPublicKeyBytes.length);
    keyInfo.set(authInfo);
    keyInfo.set(clientPublicKey, authInfo.length);
    keyInfo.set(serverPublicKeyBytes, authInfo.length + clientPublicKey.length);

    // PRKの導出（HKDF-Extract with auth secret as salt）
    const prk = await hkdfExtract(clientAuth, new Uint8Array(sharedSecretBuffer));
    
    // IKMの導出（HKDF-Expand）
    const ikm = await hkdfExpand(prk, keyInfo, 32);

    // Content encryption key (CEK)とnonceの導出
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const prk2 = await hkdfExtract(salt, ikm);
    
    // CEKの導出
    const cekInfo = encoder.encode("Content-Encoding: aes128gcm\0");
    const cek = await hkdfExpand(prk2, cekInfo, 16);
    
    // Nonceの導出（RFC 8188 Section 2.3）
    const nonceBase = await hkdfExpand(prk2, encoder.encode("Content-Encoding: nonce\0"), 12);
    const recordSequence = new Uint8Array(12).fill(0); // シーケンス番号を0で初期化
    const nonce = new Uint8Array(12);
    for (let i = 0; i < 12; i++) {
      nonce[i] = nonceBase[i] ^ recordSequence[i];
    }

    // 暗号化キーのインポート
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      cek,
      {
        name: 'AES-GCM',
        length: 128
      },
      false,
      ['encrypt']
    );

    // ペイロードの暗号化
    const plaintext = encoder.encode(payload);
    
    // レコードサイズの計算（RFC 8188 Section 2）
    const recordSize = Math.min(4096, Math.ceil((plaintext.length + 16) / 16) * 16); // 16バイトアラインメント
    
    // パディング処理
    const paddingSize = recordSize - (plaintext.length + 16);
    const paddedPlaintext = new Uint8Array(plaintext.length + paddingSize);
    paddedPlaintext.set(plaintext);
    if (paddingSize > 0) {
      paddedPlaintext.fill(0, plaintext.length, paddedPlaintext.length - 1);
      paddedPlaintext[paddedPlaintext.length - 1] = 0x02; // パディングデリミタ
    }

    // 暗号化パラメータのログ出力
    console.log("暗号化パラメータ:", {
      saltLength: salt.length,
      keyLength: cek.length,
      nonceLength: nonce.length,
      recordSize,
      tagLength: 16
    });

    // ヘッダー構築（RFC 8188 Section 2.1）
    const headerSize = 16 + 4 + 1 + serverPublicKeyBytes.length;
    const header = new Uint8Array(headerSize);
    let pos = 0;

    // salt (16 bytes)
    header.set(salt, pos);
    pos += 16;

    // record size (4 bytes, big-endian)
    const recordSizeView = new DataView(header.buffer, pos, 4);
    recordSizeView.setUint32(0, recordSize, false);
    pos += 4;

    // keyid length (1 byte)
    header[pos++] = serverPublicKeyBytes.length;

    // keyid (server public key)
    header.set(serverPublicKeyBytes, pos);

    // AES-GCM暗号化（RFC 8188 Section 2.2）
    const encryptedData = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        tagLength: 128
      },
      cryptoKey,
      paddedPlaintext
    );

    // 暗号化されたデータをUint8Arrayに変換
    const encryptedContent = new Uint8Array(encryptedData);
    
    // 最終的な暗号化ペイロード
    const encryptedPayload = new Uint8Array(header.length + encryptedContent.length);
    encryptedPayload.set(header);
    encryptedPayload.set(encryptedContent, header.length);

    // ペイロードサイズの検証
    if (encryptedPayload.length > 4096) {
      throw new Error(`暗号化されたペイロードが大きすぎます: ${encryptedPayload.length} bytes`);
    }

    console.log("暗号化詳細:", {
      headerSize,
      saltLength: salt.length,
      recordSize,
      keyidLength: serverPublicKeyBytes.length,
      contextLength: keyInfo.length,
      plaintextLength: plaintext.length,
      paddingSize,
      paddedPlaintextLength: paddedPlaintext.length,
      ciphertextLength: encryptedContent.length,
      finalLength: encryptedPayload.length
    });

    return encryptedPayload;
  } catch (error) {
    console.error('暗号化エラー:', error);
    throw error;
  }
}

// HMAC実装
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(signature);
}

// HKDF抽出ステップ
async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return await hmac(salt, ikm);
}

// HKDF展開ステップ
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const byteLen = length;
  const result = new Uint8Array(byteLen);
  let currentT = new Uint8Array(0);
  const counter = new Uint8Array(1);
  let pos = 0;
  
  for (counter[0] = 1; pos < byteLen; counter[0]++) {
    const hmacInput = new Uint8Array(currentT.length + info.length + 1);
    hmacInput.set(currentT, 0);
    hmacInput.set(info, currentT.length);
    hmacInput.set(counter, currentT.length + info.length);
    
    const stepHmac = await hmac(prk, hmacInput);
    currentT = stepHmac;
    
    const stepSize = Math.min(byteLen - pos, currentT.length);
    result.set(currentT.subarray(0, stepSize), pos);
    pos += stepSize;
  }
  
  return result;
}

// 低レベルWebPush通知送信
async function sendPushNotification(subscription: any, payload: string, vapidKeys: { publicKey: string, privateKey: string }) {
  try {
    const endpoint = subscription.endpoint;
    const audience = new URL(endpoint).origin;
    
    // JWTヘッダーとペイロード
    const header = {
      typ: 'JWT',
      alg: 'ES256'
    };
    
    const currentTime = Math.floor(Date.now() / 1000);
    const expirationTime = currentTime + (12 * 60 * 60); // 12時間
    
    console.log("JWT準備:", { audience, exp: expirationTime });

    // JWTトークン生成
    try {
      // Base64からバイナリに変換
      const privateKeyBuffer = urlBase64ToUint8Array(vapidKeys.privateKey);
      console.log("秘密鍵バイナリ変換成功");

      // JWKを作成 - jose形式のJWK
      const jwk = {
        kty: 'EC',
        crv: 'P-256',
        x: jose.base64url.encode(privateKeyBuffer.slice(0, 32)),
        y: jose.base64url.encode(privateKeyBuffer.slice(32, 64)),
        d: jose.base64url.encode(privateKeyBuffer)
      };
      
      // キーのインポート
      const privateKey = await jose.importJWK(jwk, 'ES256');
      
      console.log("秘密鍵インポート成功");

      // JWTトークンを作成して署名
      const token = await new jose.SignJWT({
        aud: audience,
        exp: expirationTime,
        sub: 'mailto:imuradevelopmentauth@gmail.com'
      })
      .setProtectedHeader(header)
      .sign(privateKey);
      
      console.log("JWT生成成功");
      
      // FCM向けの特別な処理
      const isFCM = endpoint.includes('fcm.googleapis.com');
      
      // ペイロードの暗号化
      const encryptedPayload = await encryptPayload(subscription, payload);
      
      // プッシュサービスにリクエスト送信
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'TTL': '86400',
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'Content-Length': encryptedPayload.length.toString(),
          'Urgency': 'high',
          'Authorization': `vapid t=${token}, k=${vapidKeys.publicKey}`,
        },
        body: encryptedPayload
      });
      
      if (response.ok) {
        console.log("プッシュ通知送信成功:", response.status);
        return { success: true, status: response.status };
      } else {
        // レスポンステキストを一度だけ取得
        const responseText = await response.text();
        console.error("プッシュ通知送信失敗:", response.status, responseText);
        return { success: false, status: response.status, error: responseText };
      }
    } catch (jwtError) {
      console.error("JWT生成エラー:", jwtError);
      return { success: false, error: `JWT生成エラー: ${jwtError.message}` };
    }
  } catch (error) {
    console.error("プッシュ通知エラー:", error);
    return { success: false, error: error.message };
  }
}

serve(async (req) => {
  // CORSヘッダー
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey'
  };

  // OPTIONSリクエスト（プリフライト）の処理
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  try {
    // user_idの代わりにcategory_idを受け取る
    const { category_id, title, article_id, body } = await req.json();
    console.log("リクエスト処理:", { category_id, title, body });

    // VAPIDキー取得
    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY') || '';
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY') || '';
    
    if (!vapidPublicKey || !vapidPrivateKey) {
      throw new Error('VAPID鍵が設定されていません');
    }

    // VAPIDキー設定
    const vapidKeys = {
      publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey
    };

    // Supabase初期化
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // カテゴリをフォローしているユーザーのIDを取得
    const { data: followers } = await supabase
      .from('category_follows')
      .select('user_id')
      .eq('category_id', category_id);

    console.log(`フォロワー数: ${followers?.length || 0}`);

    // 通知送信
    const results = [];
    if (followers && followers.length > 0) {
      // フォロワーIDの配列を作成
      const followerIds = followers.map(f => f.user_id);
      
      // フォロワーのプッシュ購読情報を取得
      const { data: subscriptions } = await supabase
        .from('push_subscriptions')
        .select('subscription_json')
        .in('user_id', followerIds);
      
      console.log(`購読数: ${subscriptions?.length || 0}`);
      
      if (subscriptions && subscriptions.length > 0) {
        for (const sub of subscriptions) {
          try {
            // 既にオブジェクトなのでJSON.parseは不要
            const subscription = sub.subscription_json;
            console.log("通知先:", subscription.endpoint);
            
            // 通知ペイロード
            const payload = JSON.stringify({
              title: title || Deno.env.get('WEBPUSH_NOTIFICATION_TITLE') || 'お知らせ',
              body: body || '新しい記事が追加されました',
              icon: '/icon.png',
              data: {
                timestamp: Date.now().toString(),
                article_id: article_id // 記事IDを追加（通知クリック時の遷移用）
              }
            });

            console.log("送信ペイロード:", payload);

            // 通知送信
            console.log("通知送信開始:", subscription.endpoint);
            const result = await sendPushNotification(subscription, payload, vapidKeys);
            console.log("通知送信結果:", result);
            results.push(result);
          } catch (error) {
            console.error("通知処理エラー:", error);
            results.push({ success: false, error: error.message });
          }
        }
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      results 
    }), {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });

  } catch (error) {
    console.error("全体エラー:", error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}); 