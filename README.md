# TOEIC ランダム出題

Excel ツール（`TOEIC_2.xlsm`）をブラウザで使えるようにしたものです。
TOEIC の各パートの問題をランダムな順で出題し、「やった」を記録します。

- **進行**：次の問題を表示 →「✓ やった → 次へ」で記録。「新規セッション開始」「セッション再開」は Excel 版と同じ動き
- **やった登録**：アプリを使わずに解いた問題をクリックで登録。登録した問題は**新規セッションに出題されず**、進行中のセッションでも自動で飛ばされる
- **記録**：セッションごとの実施状況
- **設定**：パート名・問題数・出題モード（全体シャッフル＝同パート3連続なし／パート順シャッフル）、GitHub 同期設定

## 記録（データベース）

すべての記録は [`data/records.json`](data/records.json) の1ファイルに保存されます。
アプリで操作するたびに GitHub へ自動コミットされるので、別の PC でもそのまま続きから使えます。

### アプリを使わずに「やった」を直接記録する

`data/records.json` の `"done"` に追記してコミット＆プッシュするだけで、その問題はランダム出題の対象から外れます。

```json
"done": [
  {"part": "パート3", "q": 5, "date": "2026-09-29", "note": "紙で解いた"},
  {"part": "パート7", "q": 12, "date": "2026-09-29"}
],
```

`part` は設定のパート名と完全に一致させてください。空のときは `"done": []` です。

## 使い方

### 公開 URL で使う
GitHub Pages の URL（`https://<ユーザー名>.github.io/TOEIC/`）を開くだけです。

### 別の PC で使う
```
git clone https://github.com/<ユーザー名>/TOEIC.git
```
`index.html` をブラウザで開き、「設定」タブでリポジトリ（`<ユーザー名>/TOEIC`）とトークンを入力します。
（記録は GitHub から直接読み書きするので、以後の `git pull` は必須ではありません）

### 記録を書き込むためのトークン（最初に1回、PC/ブラウザごと）
1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
2. Repository access：**Only select repositories** → `TOEIC`
3. Permissions → Repository permissions → **Contents: Read and write**
4. 作成したトークンをアプリの「設定」タブ → トークン欄に貼り付けて「保存して再読み込み」

トークンはそのブラウザの中にだけ保存され、リポジトリには含まれません。
トークン未設定のブラウザ（他の人を含む）では閲覧のみで、記録は変更できません。

## Excel からの取り込み
```
python tools/import_xlsm.py C:\path\to\TOEIC_2.xlsm
```
`data/records.json` を Excel の内容で作り直します（Excel の正解/不正解/スキップはすべて「やった」扱い）。
