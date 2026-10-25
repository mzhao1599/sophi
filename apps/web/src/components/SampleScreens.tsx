"use client";

import { PRESET_ORDER, PRESET_REPLIES } from "@/lib/phoneApi";
import { PRODUCT_NAME } from "@/lib/brand";
import { SAMPLE_DESTINATION, SAMPLE_DESTINATION_SHORT, SAMPLE_THREAD, SAMPLE_WALK } from "@/lib/sampleScreens";
import { RouteMap } from "./RouteMap";
import { WalkerMark } from "./WalkerMark";
import phone from "./Phone.module.css";
import styles from "./Sample.module.css";

/**
 * The two sample phone screens for the stage (src/lib/sampleScreens.ts): Maya's phone with Rose's walk on a
 * map, and Rose's phone with her messages. Each is drawn as a phone in the middle of a half-laptop window
 * (full width on a real phone), for a glance during the demo, and carries one "Sample" tag in its top
 * corner. Nothing on them is live and nothing can be pressed.
 */
function SampleFrame({ who, label, children }: { who: string; label: string; children: React.ReactNode }) {
  return (
    <div className={`${phone.root} ${styles.stage}`}>
      <div className={styles.device} role="region" aria-label={label}>
        <header className={styles.bar}>
          <span className={phone.brand}>
            <WalkerMark size={28} />
            {PRODUCT_NAME}
          </span>
          <span className={styles.who}>{who}</span>
          <span className={`${phone.tag} ${styles.sampleTag}`}>Sample</span>
        </header>
        <main id="main" className={styles.body}>
          {children}
        </main>
      </div>
    </div>
  );
}

export function CaretakerSample() {
  const { leftM, leftMin } = SAMPLE_WALK;
  return (
    <SampleFrame who="Maya's phone" label="Sample screen: Maya's phone, made-up data">
      <section className={styles.walk} aria-labelledby="walk-title">
        <div className={styles.walkHead}>
          <p className={styles.live}>
            <span className={styles.liveDot} aria-hidden="true" />
            Walking now
          </p>
          <h1 id="walk-title" className={styles.walkTitle}>
            Rose is on her way
          </h1>
        </div>
        <WalkMap />
        <div className={styles.eta}>
          <p className={styles.etaBig}>
            {leftMin} min <span className={styles.etaLeft}>left</span>
          </p>
          <p className={styles.etaTo}>
            {leftM} m to the {SAMPLE_DESTINATION}
          </p>
          <p className={styles.etaMeta}>Walker online · Updated just now</p>
        </div>
      </section>
    </SampleFrame>
  );
}

export function RoseSample() {
  return (
    <SampleFrame who="Rose's phone" label="Sample screen: Rose's phone, made-up data">
      <section className={styles.chat} aria-labelledby="chat-title">
        <h1 id="chat-title" className={styles.chatTitle}>
          Messages with Maya
        </h1>
        <ol className={styles.thread}>
          {SAMPLE_THREAD.map((m, i) => (
            <li key={i} className={styles.bubble} data-mine={m.from === "rose" || undefined}>
              <span className={styles.bubbleWho}>
                {m.from === "rose" ? "You" : "Maya"} · {m.at}
              </span>
              <span className={styles.bubbleText}>{m.text}</span>
              {m.from === "maya" ? (
                <span className={styles.readAloud}>
                  <SpeakerIcon />
                  Read aloud on your walker
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <div className={styles.replies}>
          <h2 className={styles.repliesTitle}>Reply to Maya</h2>
          <ul className={styles.replyList}>
            {PRESET_ORDER.map((p) => (
              <li key={p} className={styles.reply}>
                {PRESET_REPLIES[p]}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </SampleFrame>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11" />
    </svg>
  );
}

function WalkMap() {
  return (
    <RouteMap
      className={styles.mapFigure}
      at={SAMPLE_WALK.at}
      herName="Rose"
      behind={SAMPLE_WALK.behind}
      ahead={SAMPLE_WALK.ahead}
      start={SAMPLE_WALK.start}
      end={{ at: SAMPLE_WALK.end, label: SAMPLE_DESTINATION_SHORT }}
      caption={`Sample map by Lake Merritt, Oakland: Rose's route to the ${SAMPLE_DESTINATION}, with the part she has walked and her position, ${SAMPLE_WALK.leftM} metres before the end.`}
    />
  );
}
