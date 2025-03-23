-- カテゴリテーブル
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  user_id UUID REFERENCES auth.users NOT NULL,
  creator_name TEXT NOT NULL DEFAULT 'ユーザー',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 記事テーブル
CREATE TABLE articles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category_id UUID REFERENCES categories ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- プッシュ通知購読情報
CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users NOT NULL,
  subscription_json JSONB NOT NULL,
  endpoint TEXT GENERATED ALWAYS AS (subscription_json->>'endpoint') STORED,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, endpoint)
);

-- プロフィールテーブル
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  username TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- カテゴリフォローテーブル
CREATE TABLE category_follows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users NOT NULL,
  category_id UUID REFERENCES categories NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, category_id)
);

-- ROWレベルセキュリティ設定
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_follows ENABLE ROW LEVEL SECURITY;

-- RLS ポリシー設定（カテゴリ）
-- 元のポリシーを削除
DROP POLICY IF EXISTS "ユーザー自身のカテゴリのみ閲覧可能" ON categories;

-- 新しいポリシー
CREATE POLICY "全カテゴリ閲覧可能" ON categories
  FOR SELECT USING (true);
  
CREATE POLICY "ユーザー自身がカテゴリを作成可能" ON categories
  FOR INSERT WITH CHECK (auth.uid() = user_id);
  
CREATE POLICY "ユーザー自身のカテゴリのみ更新可能" ON categories
  FOR UPDATE USING (auth.uid() = user_id);
  
CREATE POLICY "ユーザー自身のカテゴリのみ削除可能" ON categories
  FOR DELETE USING (auth.uid() = user_id);

-- 記事のポリシーも修正（カテゴリの閲覧制限が変わったため）
DROP POLICY IF EXISTS "ユーザー自身のカテゴリの記事のみ閲覧可能" ON articles;
CREATE POLICY "カテゴリに紐づく記事は閲覧可能" ON articles
  FOR SELECT USING (true);
  
DROP POLICY IF EXISTS "ユーザー自身のカテゴリにのみ記事追加可能" ON articles;
CREATE POLICY "ユーザー自身のカテゴリにのみ記事追加可能" ON articles
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM categories 
      WHERE categories.id = articles.category_id 
      AND categories.user_id = auth.uid()
    )
  );

-- 通知購読のポリシー（変更なし）
CREATE POLICY "ユーザー自身の購読情報のみ閲覧可能" ON push_subscriptions
  FOR SELECT USING (auth.uid() = user_id);
  
CREATE POLICY "ユーザー自身の購読情報のみ追加可能" ON push_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "ユーザー自身の購読情報のみ更新可能" ON push_subscriptions
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "ユーザー自身の購読情報のみ削除可能" ON push_subscriptions
  FOR DELETE USING (auth.uid() = user_id);

-- プロフィールテーブルのポリシー
CREATE POLICY "プロフィールは全員閲覧可能" ON profiles
  FOR SELECT USING (true);
  
CREATE POLICY "自分のプロフィールのみ編集可能" ON profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "ユーザー自身のプロフィールのみ追加可能" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- カテゴリフォローのポリシー
CREATE POLICY "ユーザー自身のフォロー情報のみ閲覧可能" ON category_follows
  FOR SELECT USING (auth.uid() = user_id);
  
CREATE POLICY "ユーザー自身のフォロー情報のみ追加可能" ON category_follows
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "ユーザー自身のフォロー情報のみ削除可能" ON category_follows
  FOR DELETE USING (auth.uid() = user_id);
