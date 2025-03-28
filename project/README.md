# AIPlatform

AIを活用したコンテンツ生成とプッシュ通知機能を備えたWebアプリケーション

## 主要機能

- ユーザー認証（ログイン/登録）
- カテゴリ管理（作成、編集、削除）
- カテゴリフォロー機能
- AI（Google Gemini）による記事自動生成
- Webプッシュ通知
- カテゴリごとの自動記事生成スケジュール設定

## 新機能: 自動記事生成

各カテゴリオーナーは、最新のAI自動記事生成機能を設定できるようになりました。

### 主な特徴

- カテゴリごとに自動生成の有効/無効を設定可能
- 生成間隔は5分〜24時間（1440分）まで自由に設定可能
- デフォルトは30分間隔
- 自動生成された記事はフォロワーにプッシュ通知で配信

### 設定方法

1. カテゴリの作成または編集画面で「自動生成」チェックボックスをオン
2. 生成間隔（分）を設定
3. 保存ボタンをクリック

## 技術スタック

- フロントエンド: Vue.js
- バックエンド: Supabase (PostgreSQL)
- AI: Google Gemini API
- 通知: Web Push API, Service Worker
- スケジューリング: pg_cron, pg_net

## セットアップ手順

### Supabaseプロジェクト設定

1. Supabaseダッシュボードで新プロジェクト作成
2. プロジェクト設定 > データベース > 拡張機能から以下を有効化:
   - pg_cron
   - pg_net
   - vault
3. マイグレーションの適用:
   - `project/supabase/migrations/20250323035027_initial_schema.sql`
   - `project/supabase/migrations/20250328091256_auto_generate_settings.sql`
4. Vaultの設定:
   - project/supabase/sql/vault_setup.sql を実行

### 新しいエッジ関数のデプロイ

```bash
cd project
supabase functions deploy auto-generate
```

### アプリケーション実行

```bash
cd project
npm install
npm run dev
```

## 注意事項

- 自動生成機能を利用するには、Supabase Proプランまたは同等のプランが必要です（pg_cronとVault機能を使用するため）
- Gemini APIの利用制限に注意してください
