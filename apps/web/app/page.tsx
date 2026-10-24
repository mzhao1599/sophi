import Image from "next/image";
import Link from "next/link";
import { BuildSheet } from "@/components/landing/BuildSheet";
import { CtaSentence } from "@/components/landing/CtaSentence";
import { Reveal } from "@/components/landing/Reveal";
import { WalkerMark } from "@/components/WalkerMark";
import credits from "@/../public/images/found/credits.json";
import styles from "@/components/landing/Landing.module.css";

/*
 * Landing page. taste-skill direction "The page is the object" (seed 2026717547), palette and type
 * kept from the app. The idea: the walker's build sheet (the versioned configuration the Pi receives)
 * becomes the card on the first screen, and its tear-off stub is where you tick modules and watch them
 * appear on the frame. Every picture is a credited archival print of walking aids, never presented as
 * this walker; the walker itself is drawn.
 */

const SLIP = [
  {
    when: "In the app, today",
    rows: [
      ["Tell us what you'd like help with", "6 or 7 questions"],
      ["Check what we understood", "edit any line"],
      ["Choose your modules", "each says why"],
    ],
  },
  {
    when: "On the walker, once it's built",
    rows: [
      ["Pair it with your walker", "one code"],
      ["It checks what's plugged in", "before anything starts"],
      ["You press start for any arm task", "every time"],
    ],
  },
] as const;

const MENU = [
  {
    group: "Getting around",
    items: [
      ["Obstacle sensors", "Front of the frame", "A cue when something is close. It doesn't steer or brake."],
      ["Hand controls", "Both handles", "Large buttons and a trigger, with vibration you can feel."],
    ],
  },
  {
    group: "Asking for help",
    items: [["Voice", "Between the handles", "Press a button and ask out loud. Replies also appear as text."]],
  },
  {
    group: "Reaching things",
    items: [
      ["Robot arms", "Front, on the lift", "Two small arms for light objects in a tested area, after you press start."],
      ["Arm lift", "Front column", "Raises the arms toward a shelf, between tested heights."],
    ],
  },
  {
    group: "Always included, and later",
    items: [
      ["Walker and coordinator", "The frame", "The frame, battery, stop switch and the Raspberry Pi that runs the rest."],
      ["Location sharing", "Not built yet", "For someone you choose, once it has its own consent design."],
    ],
  },
] as const;

const QUESTIONS = [
  [
    "Is this a medical device?",
    "No. It's an experimental prototype built at a hackathon. It isn't certified as a mobility aid and doesn't replace a caregiver or a clinician's advice.",
  ],
  [
    "Do I have to tell you my diagnosis?",
    "No. The setup asks what you'd like to do, where, and how you'd like to be told things. Every suggestion points back to something you said.",
  ],
  [
    "What happens to my answers?",
    "In this demo they're kept in the server's memory for an hour after your last change, then deleted. You can delete them sooner from the top of the setup.",
  ],
  [
    "Can the arms move on their own?",
    "No. The assistant can suggest a task, but the walker checks its own sensors and limits first, and the arms move only after you press start. A stop switch cuts their power directly.",
  ],
  [
    "Does it work without the internet?",
    "The assistant needs a connection. The buttons, the stop switch and obstacle cues are designed to keep working offline; that still has to be tested on the hardware.",
  ],
] as const;

type Credit = {
  file: string;
  title: string;
  creator: string | null;
  license: string;
  licenseUrl: string | null;
  page: string;
  via: string;
  date?: string | null;
};
const CREDITS = credits as Credit[];

export default function Home() {
  return (
    <>
      <Reveal />
      <div className={styles.page}>
        <header className={styles.topRow}>
          <Link href="/" className={styles.brand}>
            <WalkerMark />
            <span>Assistive Walker</span>
          </Link>
          <nav aria-label="On this page" className={styles.nav}>
            <a href="#how">How setup works</a>
            <a href="#modules">Modules</a>
            <a href="#questions">Questions</a>
          </nav>
          <Link href="/onboarding" className={`button button-primary ${styles.topAction}`}>
            Start the demo
          </Link>
        </header>

        <main id="main">
          {/* Hero: the build sheet */}
          <div className={styles.hero}>
            <BuildSheet>
              <div className={styles.cardText}>
                <h1 className={styles.title}>
                  <span className={styles.titleLeft}>Only the help</span>
                  <span className={styles.titleRight}>you choose</span>
                </h1>
                <p className={styles.cardLead}>
                  Assistive Walker is an experimental modular walker. Tell it what you&apos;d like help with, then keep only the
                  modules that fit.
                </p>
                <p className={styles.details}>
                  <span>Seven optional modules</span>
                  <span className={styles.diamond} aria-hidden="true" />
                  <span>Designed around a hardware stop</span>
                  <span className={styles.diamond} aria-hidden="true" />
                  <span>A Cal Hacks prototype</span>
                </p>
                <Link href="/onboarding" className="button button-primary">
                  Start the demo
                </Link>
              </div>
            </BuildSheet>
          </div>

          {/* How setup works: the itinerary slip */}
          <section id="how" className={styles.how} aria-labelledby="how-heading">
            <div className={styles.howText}>
              <h2 id="how-heading" className={styles.sectionTitle} data-reveal>
                How setup works
              </h2>
              <p className={styles.sectionLead} data-reveal>
                No forms about your health. A short conversation about what you&apos;d like to do, then a list you can change.
              </p>
              <figure className={styles.fragment} data-reveal>
                <div data-ui className={styles.fragmentUi} aria-hidden="true">
                  <p className={styles.fragmentQuestion}>What would you like help with?</p>
                  <ul className={styles.fragmentOptions}>
                    <li data-on="true">
                      <span className={styles.fragmentBox} />
                      Knowing when something is in my way
                    </li>
                    <li>
                      <span className={styles.fragmentBox} />
                      Picking up or reaching for things
                    </li>
                    <li data-on="true">
                      <span className={styles.fragmentBox} />
                      Controls without small, fiddly buttons
                    </li>
                  </ul>
                </div>
                <figcaption className={styles.caption}>The first question of the setup, as it appears in the app.</figcaption>
              </figure>
            </div>
            <div className={styles.slip} data-reveal>
              {SLIP.map((g) => (
                <div key={g.when} className={styles.slipGroup}>
                  <h3 className={styles.slipWhen}>{g.when}</h3>
                  <ul>
                    {g.rows.map(([what, value]) => (
                      <li key={what} className={styles.slipRow}>
                        <span>{what}</span>
                        <span className={styles.leader} aria-hidden="true" />
                        <span className={styles.slipValue}>{value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className={styles.slipTotal}>
                <span>You end with</span>
                <span>a walker set up your way</span>
              </p>
            </div>
          </section>

          {/* Modules: the printed sheet over a 1724 print of a wheeled walking frame */}
          <section id="modules" className={styles.menuBand} aria-labelledby="modules-heading">
            <Image
              src="/images/found/mother-child-old-man-with-baby-s.jpg"
              alt="An 18th-century print of an old man holding a small wooden walking frame on wheels beside a mother and child."
              fill
              sizes="100vw"
              className={`${styles.menuPhoto} ${styles.drift}`}
            />
            <div className={styles.menuSheet} data-reveal>
              <h2 id="modules-heading" className={styles.menuTitle}>
                The modules
              </h2>
              <p className={styles.menuNote}>Every module is optional except the frame. Choose in any combination.</p>
              {MENU.map((g) => (
                <div key={g.group} className={styles.menuGroup}>
                  <h3 className={styles.menuGroupName}>{g.group}</h3>
                  <ul>
                    {g.items.map(([name, where, what]) => (
                      <li key={name} className={styles.menuItem}>
                        <span className={styles.menuName}>{name}</span>
                        <span className={styles.menuWhere}>{where}</span>
                        <span className={styles.menuWhat}>{what}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className={styles.menuClose}>
                Cost, weight and power use haven&apos;t been measured yet.
                <br />
                Nothing is switched on until it passes bench tests.
              </p>
            </div>
            <p className={styles.menuCredit}>Elisha Kirkall, after a drawing in the Devonshire collection, 1724.</p>
          </section>

          {/* Who's in control: the letter */}
          <section className={styles.letterBand} aria-labelledby="control-heading">
            <article className={styles.letter} data-reveal>
              <div className={styles.letterHead}>
                <div className={styles.letterHeadText}>
                  <WalkerMark size={44} />
                  <h2 id="control-heading" className={styles.letterTitle}>
                    Who&apos;s in control
                  </h2>
                </div>
              <figure className={styles.plate}>
                <Image
                  src="/images/found/old-man-with-a-walking-stick.jpg"
                  alt="An etching of an older man in a hat, his hand resting firmly on the top of a walking stick."
                  width={1081}
                  height={1400}
                  sizes="(max-width: 640px) 40vw, 200px"
                />
                <figcaption className={styles.caption}>Wilhelm Leibl, Old Man with a Walking Stick, 1875–77.</figcaption>
              </figure>
              </div>
              <p>We started with one rule: the walker only does what you ask, and you can always stop it.</p>
              <p>
                The assistant runs in the cloud. It can answer a question or suggest a task, like picking up a cup. It can&apos;t move
                anything. Only the walker can, after it checks its own sensors and limits, and{" "}
                <mark className={styles.marker}>only once you press start</mark>.
              </p>
              <p>
                The stop switch is wired to cut power to the arms and lift directly, without going through software. If the
                internet drops, the buttons and obstacle cues are designed to keep working.
              </p>
              <p>We ask what you want to do, not what your diagnosis is. Every suggestion points to something you said, and you can change it.</p>
              <p>This is a prototype. Some of it is built and much of it isn&apos;t, and we&apos;ll always say which is which.</p>
              <p className={styles.signoff}>The Assistive Walker team</p>
              <p className={styles.role}>Cal Hacks, October 2026</p>
            </article>
          </section>

          {/* Questions beside a tall engraving */}
          <section id="questions" className={styles.faq} aria-labelledby="faq-heading">
            <div className={styles.faqText}>
              <h2 id="faq-heading" className={styles.sectionTitle} data-reveal>
                Fair questions
              </h2>
              <ul className={styles.facts} data-reveal>
                <li>The web setup works today.</li>
                <li>The walker hardware is being bench-tested.</li>
                <li>Demo answers are deleted after an hour.</li>
              </ul>
              <div className={styles.accordion} data-reveal>
                {QUESTIONS.map(([q, a]) => (
                  <details key={q} className={styles.question}>
                    <summary>{q}</summary>
                    <p>{a}</p>
                  </details>
                ))}
              </div>
              <div className={styles.faqActions} data-reveal>
                <Link href="/onboarding" className="button button-primary">
                  Start the demo
                </Link>
                <a href="#modules" className="button-text">
                  See the modules
                </a>
              </div>
            </div>
            <div className={styles.faqPictures} data-reveal>
              <div className={styles.pictureStack}>
              <figure className={styles.tall}>
                <Image
                  src="/images/found/an-old-man-with-a-beard-in.jpg"
                  alt="A 16th-century engraving of a bearded old man leaning on a wheeled walking frame, under a banner reading Ancora imparo."
                  width={1003}
                  height={1400}
                  sizes="(max-width: 900px) 100vw, 640px"
                />
              </figure>
              <figure className={styles.square}>
                <Image
                  src="/images/found/two-mothers-with-crying-babies-and-one.jpg"
                  alt="A 16th-century engraving of mothers and children; one small child walks inside a wooden frame on wheels."
                  width={1400}
                  height={1261}
                  sizes="(max-width: 900px) 40vw, 220px"
                />
              </figure>
              </div>
              <p className={styles.faqCaption}>
                “Ancora imparo”, I am still learning: an old man in a walking frame, 16th-century engraving. Below, a child&apos;s
                walking frame from the same century.
              </p>
            </div>
          </section>

          <section className={styles.cta} aria-label="Start the setup">
            <CtaSentence />
          </section>
        </main>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <p className={styles.footerName}>Assistive Walker</p>
          <div className={styles.footerRow}>
            <ul className={styles.footerPlaces}>
              <li>
                <Link href="/onboarding">Start the demo</Link>
              </li>
              <li>
                <a href="#how">How setup works</a>
              </li>
              <li>
                <a href="#modules">The modules</a>
              </li>
              <li>
                <a href="#questions">Questions</a>
              </li>
            </ul>
            <div className={styles.footerCredits}>
              <h2 className={styles.footerHeading}>Pictures</h2>
              <ul>
                {CREDITS.map((c) => (
                  <li key={c.file}>
                    <a href={c.page} rel="noreferrer" target="_blank">
                      {c.title}
                    </a>
                    {c.creator ? `, ${c.creator}` : ""}
                    {c.date ? `, ${c.date}` : ""}.{" "}
                    {c.licenseUrl ? (
                      <a href={c.licenseUrl} rel="noreferrer" target="_blank">
                        {c.license}
                      </a>
                    ) : (
                      c.license
                    )}
                    , via {c.via}.
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className={styles.legal}>
            <p>A prototype. Not a certified mobility aid or a substitute for a caregiver.</p>
            <a href="#main">Back to top</a>
          </div>
        </div>
      </footer>
    </>
  );
}
