import styles from "./HomeBrand.module.css";

export function HomeBrand() {
  return (
    <section className={styles.header} aria-label="KABUTO WAL ブランドヘッダー">
      <img
        className={styles.logo}
        src="/brand/kabuto-wal-logo.png"
        alt="KABUTO WAL 正式ブランドロゴ"
        width="1254"
        height="1254"
        fetchPriority="high"
      />
      <div className={styles.copy}>
        <p className={styles.brand}>
          KABUTO <span>WAL</span>
        </p>
        <p className={styles.tagline}>相場を知る。判断を覚える。</p>
        <p className={styles.description}>
          日本株の動きを、AIと過去の記憶で読み解く。
        </p>
      </div>
    </section>
  );
}
