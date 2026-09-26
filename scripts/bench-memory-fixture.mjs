const filler = "この説明用の人工履歴は性能評価だけに使う。実在の設定・会話・認証情報を含まない。 ".repeat(45);

export const MEMORY_BENCH_CORPUS = Object.freeze([
	{
		id: "release-rx2048",
		role: "user",
		outcome: "completed",
		timestamp: "2026-09-21T08:10:00+09:00",
		content: "リリース記録: release-17 の配布物IDは RX-2048、版は v2.7.14。検証ジョブの最大試行回数は 6 回。",
	},
	{
		id: "region-old",
		role: "assistant",
		outcome: "completed",
		timestamp: "2026-09-19T17:20:00+09:00",
		content: "旧メモ: staging / Osaka region は ap-northeast-1 と記録されていた。後日の訂正前の値であり、現行の選択として使わない。",
	},
	{
		id: "region-correction",
		role: "user",
		outcome: "completed",
		timestamp: "2026-09-22T10:05:00+09:00",
		content: "訂正: staging / Osaka の現行 region は ap-northeast-3。region-old の ap-northeast-1 は古い値なので置き換える。",
	},
	{
		id: "rebuild-failed",
		role: "tool",
		outcome: "failed",
		timestamp: "2026-09-22T11:00:00+09:00",
		content: "実行結果: node scripts/rebuild-index.mjs --batch 8 は終了コード 73 で失敗。書込み件数は 0。これは成功手順ではなく、再実行が成功した記録もまだない。",
	},
	{
		id: "timeout-unverified",
		role: "assistant",
		outcome: "unverified",
		timestamp: "2026-09-22T11:15:00+09:00",
		content: "未確認の仮説: fixture endpoint の timeout は 80 秒かもしれない。実測も設定確認もしておらず、確定値として扱わない。",
	},
	{
		id: "attachment-policy",
		role: "user",
		outcome: "completed",
		timestamp: "2026-09-22T12:00:00+09:00",
		content: "添付画像は既存の blob 保管先への参照と SHA-256 を記録する。検索DBへ base64 本文を複製しない。",
	},
	{
		id: "test-entrypoint",
		role: "user",
		outcome: "completed",
		timestamp: "2026-09-22T13:30:00+09:00",
		content: "人工テストの入口は node scripts/run-harness-tests.mjs coding-agent test/personal-harness/memory-index.test.ts。個別テストだけ実行し、全体 suite を呼ばない。",
	},
	{
		id: "sequence-steps",
		role: "assistant",
		outcome: "completed",
		timestamp: "2026-09-22T14:00:00+09:00",
		content: "作業順序: 1) 固定fixtureを検査する。2) sourceをSQLite indexへ登録する。3) recall候補と出典を確認する。4) 回答と使用量を別々に記録する。",
	},
	{
		id: "timestamp-jst",
		role: "user",
		outcome: "completed",
		timestamp: "2026-09-22T15:35:00+09:00",
		content: "レビュー開始時刻は 2026-09-22 15:35 JST。UTCへ変換した値は 2026-09-22 06:35Z。",
	},
	{
		id: "code-identifiers",
		role: "assistant",
		outcome: "completed",
		timestamp: "2026-09-23T09:10:00+09:00",
		content: "コード識別子: PersonalMemoryStore.recall は MemoryIndex.search の候補を元にし、MemoryCurator が出典付きの CuratedMemory を返す。派生recallは MemorySourceRecord.origin=derived-recall として原文indexへ戻さない。",
	},
	{
		id: "long-detail-tail",
		role: "tool",
		outcome: "completed",
		timestamp: "2026-09-23T10:25:00+09:00",
		content: `長い人工ログの冒頭。${filler}${filler}${filler}末尾の確認値は ATTACH-85、検査対象の末尾 marker は uv-postfix-6c2f、行番号は 418。ここは古い要約に含めず、原記録を検索して確認する。`,
	},
	{
		id: "noise-ssh",
		role: "assistant",
		outcome: "completed",
		timestamp: "2026-09-23T10:30:00+09:00",
		content: "無関係な人工メモ: network sandbox の ssh handshake fixture は cipher DEMO-CHACHA20-POLY1305 を表示した。memory recall の回答とは関係しない。",
	},
	{
		id: "numeric-threshold",
		role: "user",
		outcome: "completed",
		timestamp: "2026-09-23T11:40:00+09:00",
		content: "数値条件: 1 回の excerpt 上限は 2,500 文字、curation 入力上限は 12,000 文字、curated 出力上限は 1,000 文字。これは人工 fixture の値。",
	},
	{
		id: "japanese-correction-context",
		role: "tool",
		outcome: "completed",
		timestamp: "2026-09-23T12:10:00+09:00",
		content: "訂正経路の人工例: sourceRevision r2 が r1 を supersede する。検索時には r2 の出典を優先し、r1 の値を現行として返さない。",
	},
]);

export const MEMORY_BENCH_QUESTIONS = Object.freeze([
	{
		id: "artifact-id-and-version",
		query: "release-17 配布物ID version 検証回数",
		expected: { answerIncludes: ["RX-2048", "v2.7.14", "6"], sourceIds: ["release-rx2048"] },
		staleSourceIds: [],
	},
	{
		id: "corrected-region",
		query: "staging Osaka region 現行 訂正",
		expected: { answerIncludes: ["ap-northeast-3"], sourceIds: ["region-correction"] },
		staleSourceIds: ["region-old"],
	},
	{
		id: "failed-operation",
		query: "rebuild-index batch 8 実行 結果",
		expected: { answerIncludes: ["73", "失敗", "0"], sourceIds: ["rebuild-failed"], outcome: "failed" },
		staleSourceIds: [],
	},
	{
		id: "unverified-claim",
		query: "fixture endpoint timeout seconds 仮説",
		expected: { answerIncludes: ["80", "未確認"], sourceIds: ["timeout-unverified"], outcome: "unverified" },
		staleSourceIds: [],
	},
	{
		id: "attachment-handling",
		query: "添付画像 base64 SHA-256 blob 保管",
		expected: { answerIncludes: ["SHA-256", "base64", "参照"], sourceIds: ["attachment-policy"] },
		staleSourceIds: [],
	},
	{
		id: "test-command",
		query: "個別テスト wrapper run-harness-tests.mjs coding-agent",
		expected: { answerIncludes: ["node scripts/run-harness-tests.mjs coding-agent test/personal-harness/memory-index.test.ts"], sourceIds: ["test-entrypoint"] },
		staleSourceIds: [],
	},
	{
		id: "ordered-process",
		query: "fixture SQLite source 登録 出典 使用量 順序",
		expected: { answerIncludes: ["固定fixture", "SQLite", "recall候補", "使用量"], sourceIds: ["sequence-steps"] },
		staleSourceIds: [],
	},
	{
		id: "timestamp-and-zone",
		query: "レビュー開始 JST UTC 時刻",
		expected: { answerIncludes: ["2026-09-22 15:35 JST", "2026-09-22 06:35Z"], sourceIds: ["timestamp-jst"] },
		staleSourceIds: [],
	},
	{
		id: "code-contract",
		query: "PersonalMemoryStore.recall MemoryIndex.search MemoryCurator CuratedMemory derived-recall",
		expected: { answerIncludes: ["PersonalMemoryStore.recall", "MemoryIndex.search", "derived-recall"], sourceIds: ["code-identifiers"] },
		staleSourceIds: [],
	},
	{
		id: "long-tail-detail",
		query: "uv-postfix-6c2f ATTACH-85 行番号 marker",
		expected: { answerIncludes: ["ATTACH-85", "uv-postfix-6c2f", "418"], sourceIds: ["long-detail-tail"] },
		staleSourceIds: [],
	},
	{
		id: "numeric-limits",
		query: "excerpt curation 入力 出力 上限 文字数",
		expected: { answerIncludes: ["2,500", "12,000", "1,000"], sourceIds: ["numeric-threshold"] },
		staleSourceIds: [],
	},
	{
		id: "no-match",
		query: "MCP certificate rotation secret cipher expiry policy",
		expected: { answerIncludes: [], sourceIds: [], insufficient: true },
		staleSourceIds: [],
	},
]);

export const MEMORY_BENCH_REVISION = "synthetic-r12-v1";
