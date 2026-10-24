import Link from "next/link";
import type { ModuleId } from "@walker/contracts";
import { PRODUCT_NAME } from "@/lib/brand";
import { DEMO_PRICE_LABEL } from "@/lib/checkout";
import type { DemoOrder } from "@/server/checkout/order";
import { ContourField } from "./ContourField";
import { SavedWalker } from "./SavedWalker";
import { SetUpAnother } from "./SetUpAnother";
import { TopBar } from "./TopBar";
import screen from "./Screen.module.css";
import styles from "./Checkout.module.css";

const NO_MONEY = "Checkout here runs in Stripe test mode only, so no real money can move.";

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

/**
 * The page someone returns to from Stripe's test checkout. Says plainly that it was a demo and nothing
 * was charged. A paid demo order ends where the demo began: the walker, drawn again with the parts that
 * were ordered, and one button to start over with a fresh frame.
 */
export function CheckoutResult({ order }: { order: DemoOrder | { kind: "off" } | { kind: "cancelled" } }) {
  const [title, lead] = copy(order);
  if (order.kind === "paid") {
    const selected = [...new Set<ModuleId>(["base.walker", ...order.lines.flatMap((l) => (l.module_id ? [l.module_id] : []))])];
    return (
      <>
        <ContourField />
        <TopBar />
        <main id="main" className={styles.end}>
          <section className={styles.endSheet} aria-labelledby="done-title">
            <div className={styles.endHead}>
              <h1 id="done-title" className={styles.endTitle}>
                {title}
              </h1>
              <p className={styles.noMoney}>
                <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                  <path d="M5 10.4l3.2 3.1L15 6.6" />
                </svg>
                Demo order: no money moved
              </p>
            </div>
            <div className={styles.endBody}>
              <div className={styles.endWalker}>
                <SavedWalker selected={selected} />
              </div>
              <div className={styles.endFacts}>
                <h2 id="order-lines" className={styles.heading}>
                  In this demo order
                </h2>
                <ul className={styles.lines} aria-labelledby="order-lines">
                  {order.lines.map((line, i) => (
                    <li key={line.module_id ?? i}>
                      <span className={styles.name}>{line.name}</span>
                      <span className={styles.price}>
                        {money(line.amount, line.currency)} · {DEMO_PRICE_LABEL}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={styles.total}>
                  Demo total {money(order.total, order.currency)}{" "}
                  <span className={styles.price}>(sample prices; nothing was charged)</span>
                </p>
                <p className={styles.endLead}>{lead}</p>
                <div className={styles.endActions}>
                  <SetUpAnother />
                  <Link href="/" className="button-text">
                    Back to your walker
                  </Link>
                </div>
              </div>
            </div>
          </section>
        </main>
      </>
    );
  }
  return (
    <>
      <TopBar />
      <main id="main" className={screen.main}>
        <div className={screen.grid}>
          <header className={screen.span12}>
            <h1 className={screen.doneTitle}>{title}</h1>
            <p className={screen.lead}>{lead}</p>
          </header>

          <div className={`${screen.span12} ${screen.actions}`}>
            <Link href="/" className="button button-primary">
              Back to your walker
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}

function copy(order: DemoOrder | { kind: "off" } | { kind: "cancelled" }): [string, string] {
  switch (order.kind) {
    case "paid":
      return [
        "Demo order complete",
        `This was a demo order in Stripe test mode. No money moved, no card was charged and nothing will ship. ${PRODUCT_NAME} is an experimental prototype, not a certified mobility aid.`,
      ];
    case "cancelled":
      return [
        "Demo checkout cancelled",
        "You left Stripe's test checkout before paying. This was a demo order: no money moved and nothing was charged. Your saved walker hasn't changed.",
      ];
    case "unpaid":
      return ["This demo order wasn't completed", `Stripe hasn't marked this test order as paid, so nothing was charged. ${NO_MONEY}`];
    case "not_found":
      return ["We couldn't find that demo order", `The link may be incomplete, or the order wasn't made on this site. ${NO_MONEY}`];
    case "error":
      return ["Couldn't check this demo order", `Stripe didn't answer just now. Reload the page to try again. ${NO_MONEY}`];
    case "off":
      return ["Mock purchase is off", "This server has no Stripe test key, so there's no demo order to show. No money moved."];
  }
}
