# Data License — CC BY 4.0

`data/` のファイル（`graph.json.gz`・`law_names.json.gz`・`structure.json.gz`）と `eval/results/` の集計は
**Creative Commons Attribution 4.0 International（CC BY 4.0）** で提供します。

- Legal code: https://creativecommons.org/licenses/by/4.0/legalcode
- Summary:    https://creativecommons.org/licenses/by/4.0/

出典を示せば、商用を含め自由に共有・改変できます。

## 出典表示
> e-Gov 法令検索（デジタル庁, https://laws.e-gov.go.jp/）の法令データ（スナップショット 2026-09-27）を
> JLaw-CiteGraph（https://github.com/yabooung/jp-law-citation-graph）で加工して作成

法令そのものは著作権法第13条により権利の目的となりません。`src/`・`api/`・`scripts/`・`eval/*.mjs`・`test/` のコードは
Apache-2.0（`LICENSE`）です。

## 評価に使った資料
`eval/results/` は、国税庁「質疑応答事例」を JLaw-CiteGraph が加工した `eval/v2/nta_gold.jsonl` で測った集計です。
> 出典：国税庁ホームページ「質疑応答事例」（https://www.nta.go.jp/law/shitsugi/）を加工して作成

## 実行時に取得する資料
ツールが実行時に返す条文・国会会議録の抜粋は、それぞれ e-Gov 法令API（デジタル庁）と国会会議録検索システム
（国立国会図書館）から取得したもので、このリポジトリには含みません。国会会議録の発言の利用は著作権法第40条と
同システムの利用条件に従ってください。
