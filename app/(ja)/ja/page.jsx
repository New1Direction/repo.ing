import Link from 'next/link'
import { Search, ShieldCheck, Users } from 'lucide-react'
import { BrandMark } from '../../components/brand-mark'
import styles from './page.module.css'
import { siteImage } from '../../lib/site-metadata.mjs'
import { JsonLd } from '../../components/json-ld'
import { faqJsonLd, SITE_URL } from '../../lib/json-ld.mjs'

const description = 'GitHubのOSSに市場を。公開リポジトリの市場づくりと、検証済みの開発者が取引手数料の一部を受け取る仕組みを紹介します。'
export const metadata = {
  title: 'GitHubのOSSに市場を。— repo.ing', description,
  alternates: { canonical: '/ja', languages: { en: '/', ja: '/ja', 'x-default': '/' } },
  openGraph: { type: 'website', title: 'GitHubのOSSに市場を。', description, url: '/ja', locale: 'ja_JP', siteName: 'repo.ing', images: [siteImage] },
}
const questions = [
  ['ここでいう「市場」とは何ですか？', '公開GitHubリポジトリに対応するトークンを、Solana上で売買できる場所です。トークンを持っていても、リポジトリの所有権や運営権が得られるわけではありません。'],
  ['開発者本人でなくても市場を作れますか？', 'はい。誰でも公開リポジトリを見つけて、市場を作成できます。すでに市場がある場合は、その市場を利用します。作成には対応するSolanaウォレットと、ネットワーク手数料などを支払うSOLが必要です。'],
  ['開発者向けの手数料は、誰が受け取れますか？', '対象リポジトリの管理権限を持つ方です。GitHubで権限を確認し、受取用ウォレットの所有を署名で証明したうえで、金額を確認して受け取りを申請します。市場を作成しただけでは、開発者向けの手数料を受け取る権利は得られません。'],
  ['自分のリポジトリの市場が、知らないうちに作られていたら？', '市場はコミュニティの誰でも作成できます。市場があることは、開発者の承認・提携・推奨を意味しません。ご自身が受け取れる手数料がある場合も、まずリポジトリの管理権限の確認が必要です。'],
  ['手数料は自動でウォレットに届きますか？', 'いいえ。権限確認と受取用ウォレットの設定後、受け取り可能な金額を確認して申請します。取引が発生しなければ手数料は増えず、収益は保証されません。'],
  ['日本語のまま利用できますか？', 'このページでは、仕組みとよくある質問を日本語で説明しています。市場の作成・取引・手数料の受け取り画面は、現在英語です。'],
]
function Brand() { return <Link href="/ja" className="brand" aria-label="repo.ing 日本語トップ"><BrandMark size={32}/><span className="brand-wordmark">repo.<span className="brand-accent">ing</span></span></Link> }
export default function JapaneseLanding() {
  return <div lang="ja" className={styles.page}>
    <header className={styles.header}><Brand/><nav aria-label="メインナビゲーション"><a href="#how">仕組み</a><a href="#faq">よくある質問</a><Link href="/" lang="en" hrefLang="en">English</Link></nav></header>
    <main id="main" className={styles.main}>
      <section className={styles.hero} aria-labelledby="ja-title">
        <p className={styles.eyebrow}>オープンソースから、広がる市場。</p>
        <h1 id="ja-title">GitHubのOSSに<span>市場を。</span></h1>
        <p className={styles.lead}>取引が発生すると、検証済みの開発者に手数料の一部が還元されます。</p>
        <div className={styles.actions}><Link href="/launch" className="button primary">リポジトリから市場を作る</Link><Link href="/builders" className="button outline">自分のリポジトリの手数料を確認</Link></div>
        <p className={styles.hint}>リンク先の操作画面は現在英語です。閲覧にウォレット接続は不要です。</p>
      </section>
      <section id="how" className={styles.steps} aria-label="知っておきたい3つのこと">
        <article><Search aria-hidden="true"/><span className={styles.number}>01</span><h2>見つけた人が、市場を作れる。</h2><p>気になる公開リポジトリを見つけたら、誰でも市場を作成できます。開発者本人である必要はありません。</p></article>
        <article><ShieldCheck aria-hidden="true"/><span className={styles.number}>02</span><h2>受け取りには、権限の確認を。</h2><p>開発者向けの手数料を受け取れるのは、そのリポジトリの管理権限を確認できた方です。GitHubでの確認と、受取用ウォレットの設定が必要です。</p></article>
        <article><Users aria-hidden="true"/><span className={styles.number}>03</span><h2>市場の存在 ≠ 開発者の公認。</h2><p>コミュニティが作成した市場は、開発者による承認・提携・推奨を意味しません。</p></article>
      </section>
      <section id="faq" className={styles.faq} aria-labelledby="ja-faq-title"><JsonLd data={faqJsonLd({ url: `${SITE_URL}/ja`, lang: 'ja', questions })}/><h2 id="ja-faq-title">よくある質問</h2>{questions.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</section>
      <p className={styles.risk}>トークンの価格は変動し、購入額を失う可能性があります。取引量や収益は保証されません。</p>
    </main>
    <footer className={styles.footer}><Brand/><span>オープンソースのための市場。</span><Link href="/explore">市場を見る（英語）</Link><a href="https://github.com/New1Direction/repo.ing">GitHub</a></footer>
  </div>
}
