// tests-integration/kb-architecture/phases/0-collect-thefloorr.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset, DatasetEntry, VerificationQuestion } from "../types.js";
import { writeDataset } from "../checkpoint.js";

const DATASETS_DIR = join(import.meta.dir, "..", "datasets");

/**
 * Parses a markdown file into sections based on ## and ### headers.
 * Returns array of { heading, level, content } objects.
 */
function parseMarkdownSections(
    text: string,
): Array<{ heading: string; level: number; content: string }> {
    const lines = text.split("\n");
    const sections: Array<{ heading: string; level: number; content: string }> = [];
    let currentHeading = "";
    let currentLevel = 0;
    let currentLines: string[] = [];

    for (const line of lines) {
        const h2Match = line.match(/^## (.+)/);
        const h3Match = line.match(/^### (.+)/);

        if (h2Match || h3Match) {
            // Save previous section
            if (currentHeading) {
                const content = currentLines.join("\n").trim();
                if (content) {
                    sections.push({
                        heading: currentHeading,
                        level: currentLevel,
                        content,
                    });
                }
            }
            currentHeading = (h2Match?.[1] ?? h3Match?.[1]) as string;
            currentLevel = h2Match ? 2 : 3;
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }

    // Save last section
    if (currentHeading) {
        const content = currentLines.join("\n").trim();
        if (content) {
            sections.push({ heading: currentHeading, level: currentLevel, content });
        }
    }

    return sections;
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

/**
 * Manual entry definitions with classification, supersession, and related groups.
 * Each entry maps a section heading slug to its metadata.
 */
interface EntryMeta {
    classification: string;
    supersessionGroup?: string;
    relatedGroup?: string;
}

const BUSINESS_ENTRY_META: Record<string, EntryMeta> = {
    "what-is-thefloorr": { classification: "definition", relatedGroup: "platform-overview" },
    "stylists-fri-fashion-retail-individual-pse-personal-shopper-entrepreneur-gps-guest-personal-shopper":
        { classification: "definition", relatedGroup: "stylist-role" },
    admins: { classification: "definition" },
    "brands-and-retailers": { classification: "definition", relatedGroup: "retailers" },
    "where-products-come-from": { classification: "fact", relatedGroup: "catalogue" },
    "product-structure": { classification: "reference", relatedGroup: "catalogue" },
    "regional-and-gender-partitioning": { classification: "reference" },
    "product-discovery": { classification: "reference", relatedGroup: "product-search" },
    "product-lifecycle": { classification: "concept" },
    "designers-and-brand-management": { classification: "reference" },
    "commission-on-products": { classification: "fact", relatedGroup: "commission-rules" },
    moodboards: { classification: "definition", relatedGroup: "moodboards" },
    "how-an-order-happens": { classification: "how-to", relatedGroup: "order-flow" },
    attribution: { classification: "concept", relatedGroup: "attribution" },
    "order-status-three-independent-dimensions": {
        classification: "concept",
        relatedGroup: "order-status",
    },
    "order-items": { classification: "fact", relatedGroup: "returns" },
    "returns-and-refunds": { classification: "how-to", relatedGroup: "returns" },
    "why-an-order-might-stay-pending": {
        classification: "concept",
        relatedGroup: "order-pending",
    },
    "three-payment-streams": { classification: "concept", relatedGroup: "payment-streams" },
    "pse-payment-thefloorr-stylist": {
        classification: "how-to",
        relatedGroup: "pse-payment",
    },
    "thefloorr-revenue": { classification: "fact" },
    "why-pse-payment-might-be-delayed": {
        classification: "fact",
        relatedGroup: "payment-delay",
    },
    "commission-calculation-example": {
        classification: "how-to",
        relatedGroup: "commission-example",
    },
    "currency-handling": { classification: "reference" },
    "manual-adjustments": { classification: "reference" },
    "order-snapshots-and-corrections": { classification: "reference", relatedGroup: "corrections" },
    notifications: { classification: "reference", relatedGroup: "notifications" },
    "teams-and-sales-targets": { classification: "reference", relatedGroup: "teams" },
    "network-payment-affiliate-network-thefloorr": {
        classification: "how-to",
        relatedGroup: "payment-streams",
    },
};

const PSE_ENTRY_META: Record<string, EntryMeta> = {
    "what-is-thefloorr": { classification: "definition", relatedGroup: "platform-overview" },
    "how-you-earn-money": { classification: "how-to", relatedGroup: "commission-rules" },
    "the-purchase-flow": { classification: "how-to", relatedGroup: "order-flow" },
    "order-statuses": { classification: "concept", relatedGroup: "order-status" },
    "why-your-order-might-stay-pending": {
        classification: "concept",
        relatedGroup: "order-pending",
    },
    "returns-and-how-they-affect-your-commission": {
        classification: "how-to",
        relatedGroup: "returns",
    },
    "why-an-order-might-be-rejected": { classification: "fact" },
    "how-you-get-paid": { classification: "how-to", relatedGroup: "pse-payment" },
    "why-your-payment-might-be-delayed": {
        classification: "fact",
        relatedGroup: "payment-delay",
    },
    "commission-example": { classification: "how-to", relatedGroup: "commission-example" },
    "viewing-your-earnings": { classification: "reference" },
    consultations: { classification: "definition" },
    "creating-looks": { classification: "how-to" },
    moodboards: { classification: "definition", relatedGroup: "moodboards" },
    chat: { classification: "reference" },
    "the-catalogue": { classification: "fact", relatedGroup: "catalogue" },
    "searching-and-filtering": { classification: "reference", relatedGroup: "product-search" },
    "product-pricing": { classification: "reference" },
    "commission-considerations-when-choosing-products": {
        classification: "fact",
        relatedGroup: "commission-rules",
    },
    "trackable-links": { classification: "concept", relatedGroup: "attribution" },
    teams: { classification: "reference", relatedGroup: "teams" },
    notifications: { classification: "reference", relatedGroup: "notifications" },
    "important-things-to-remember": { classification: "insight" },
};

function getManualEntries(): DatasetEntry[] {
    return [
        // Supersession pair: deprecated naming
        {
            id: "supersession-stylist-name-old",
            content:
                "Stylists on TheFloorr are called FRI (Fashion Retail Individual) or GPS (Guest Personal Shopper). FRI is the standard stylist role, and GPS refers to guest stylists who are invited for specific projects.",
            expectedClassification: "definition",
            supersessionGroup: "stylist-naming",
        },
        {
            id: "supersession-stylist-name-new",
            content:
                "Stylists on TheFloorr are now called PSE (Personal Shopper Entrepreneur). The old names FRI (Fashion Retail Individual) and GPS (Guest Personal Shopper) are deprecated and no longer used. From the system's perspective, FRI, GPS, and PSE are the same thing.",
            expectedClassification: "definition",
            supersessionGroup: "stylist-naming",
        },
        // Supersession pair: deprecated features
        {
            id: "supersession-looks-old",
            content:
                "Stylists can create Looks and Consultations (also called Styling Sessions) for their clients. A Look is a curated outfit combination, and a Consultation captures the client's needs including sizing, inspiration, and due dates. Stylists submit and publish Looks within Consultations.",
            expectedClassification: "how-to",
            supersessionGroup: "looks-feature",
        },
        {
            id: "supersession-looks-new",
            content:
                "The Looks and Consultations features are deprecated and no longer available in the system. PSE's direct communication with clients through the platform is also deprecated. Currently, PSEs are purchasing products themselves or sharing trackable links and moodboards publicly.",
            expectedClassification: "fact",
            supersessionGroup: "looks-feature",
        },
        // Supersession pair: order rejection terminology
        {
            id: "supersession-rejected-old",
            content:
                "When a customer returns all items from an order, the order status is set to 'rejected' in the system. Rejected orders generate no commission for the stylist.",
            expectedClassification: "fact",
            supersessionGroup: "rejected-terminology",
        },
        {
            id: "supersession-rejected-new",
            content:
                "'Rejected' is an old deprecated name for 'returned' in TheFloorr's order system. Always use 'returned' instead of 'rejected' when describing orders where items were sent back. The internal status reflects this: if all items have been returned, the order is internally marked as returned.",
            expectedClassification: "fact",
            supersessionGroup: "rejected-terminology",
        },
    ];
}

function getVerificationQuestions(entryIds: string[]): VerificationQuestion[] {
    // Helper to find entry IDs by prefix
    const findIds = (prefix: string): string[] => entryIds.filter((id) => id.startsWith(prefix));

    const _businessIds = findIds("biz-");
    const _pseIds = findIds("pse-");

    // Find specific entries by slug content
    const findBySlug = (prefix: string, slugPart: string): string[] =>
        entryIds.filter((id) => id.startsWith(prefix) && id.includes(slugPart));

    return [
        // Easy questions
        {
            id: "q-what-is-thefloorr",
            question: "What is TheFloorr and how does it make money?",
            expectedAnswer:
                "TheFloorr is a luxury fashion personal styling platform that connects professional stylists with fashion-conscious clients. It does not sell products directly. Instead, it earns revenue through affiliate commissions when purchases are made through trackable links generated on the platform. Both TheFloorr and the stylist earn a share of the commission.",
            requiredEntryIds: findBySlug("biz-", "what-is-thefloorr"),
            excludedEntryIds: [],
            difficulty: "easy",
        },
        {
            id: "q-affiliate-networks",
            question: "What affiliate networks does TheFloorr use for its product catalogue?",
            expectedAnswer:
                "TheFloorr uses three affiliate networks: Rakuten, Commission Junction (CJ), and Partnerize. These networks provide product data feeds from hundreds of retailers, which are downloaded multiple times a day through an automated pipeline.",
            requiredEntryIds: findBySlug("biz-", "where-products-come-from"),
            excludedEntryIds: [],
            difficulty: "easy",
        },
        {
            id: "q-what-is-moodboard",
            question: "What is a Moodboard on TheFloorr?",
            expectedAnswer:
                "A Moodboard is a curated product collection used for inspiration. Stylists create them to organise ideas for clients. Moodboards can be public or private, shared with specific users, and used as templates for teams. They contain products from the catalogue along with notes and inspiration.",
            requiredEntryIds: findBySlug("biz-", "moodboards"),
            excludedEntryIds: [],
            difficulty: "easy",
        },

        // Medium questions
        {
            id: "q-how-stylist-earns",
            question:
                "How does a stylist earn commission on TheFloorr? Walk me through the process.",
            expectedAnswer:
                "A stylist recommends products to clients using Moodboards or by sharing trackable links. When a client clicks a trackable link and purchases the product at the retailer's website, the affiliate network records the sale. Commission is generated and attributed to the stylist. The default split is 80% to the stylist and 20% to TheFloorr. Commission rates vary by retailer and can differ for full-price versus sale items.",
            requiredEntryIds: findBySlug("biz-", "how-an-order-happens"),
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-payment-delayed",
            question: "Why might a stylist's commission payment be delayed?",
            expectedAnswer:
                "Several reasons: (1) The affiliate network has not yet paid TheFloorr — the order's affiliate payment status is still pending. (2) The order is still pending approval at the network level. (3) The commission has not yet been approved for payment in the admin system. (4) The Revolut payment draft has not been created or sent yet.",
            requiredEntryIds: findBySlug("biz-", "payment-might-be-delayed"),
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-partial-return",
            question: "What happens when a customer returns one item from a multi-item order?",
            expectedAnswer:
                "Only the returned item's commission is affected. The order-level amounts are recalculated: the gross sale amount stays the same (representing the original order), but the net sale amount decreases by the returned item's value. The stylist still earns commission on the items that were kept. The order may show a 'mixed' status.",
            requiredEntryIds: findBySlug("biz-", "order-items"),
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-attribution",
            question: "What is attribution on TheFloorr and why does it matter?",
            expectedAnswer:
                "Attribution is the connection between a purchase and TheFloorr. When someone clicks a trackable link, TheFloorr records which product was clicked, who clicked it, and who created the link. If the product is bought, the affiliate network matches the sale back to that click, allowing TheFloorr to attribute the order to the right stylist for commission purposes. If an order cannot be matched to a specific stylist or click, the commission goes entirely to TheFloorr rather than being split with a stylist.",
            requiredEntryIds: findBySlug("biz-", "attribution"),
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-order-statuses",
            question:
                "How do order statuses work on TheFloorr? What are the different status dimensions?",
            expectedAnswer:
                "Every order has three separate, independent status tracks: (1) Affiliate Order Status — what the affiliate network reports (pending, new, approved, auto-approved, returned, declined, closed, locked, mixed). (2) Internal Order Status — TheFloorr's own assessment, calculated from affiliate status and item states. (3) Manual Status — an admin override that forces the internal status regardless of network data. These three dimensions move independently.",
            requiredEntryIds: findBySlug("biz-", "order-status"),
            excludedEntryIds: [],
            difficulty: "medium",
        },

        // Hard questions
        {
            id: "q-return-after-payment",
            question:
                "A client buys a 500 pound dress from a retailer that pays 10% commission. The stylist's rate is 80%. If the client returns the dress after the affiliate network has already paid TheFloorr, what happens financially?",
            expectedAnswer:
                "Total commission was 50 pounds (10% of 500). Stylist's share was 40 pounds (80% of 50), TheFloorr's share was 10 pounds. After return: the affiliate network does not send money back — instead it deducts 50 pounds from the next month's payment to TheFloorr. If the stylist's 40 pounds has already been paid, the overpayment is tracked against the stylist's balance and deducted from future earnings.",
            requiredEntryIds: [
                ...findBySlug("biz-", "commission-calculation-example"),
                ...findBySlug("biz-", "returns-and-refunds"),
            ],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-rakuten-vs-cj",
            question:
                "How does order handling differ between Rakuten and CJ networks on TheFloorr?",
            expectedAnswer:
                "Key differences: (1) Approval: Rakuten has no explicit approval step — an order is considered approved only when Rakuten actually pays the commission. CJ has a standard approval/rejection flow. (2) Returns tracking: For Rakuten, TheFloorr keeps historical snapshots of what the order looked like at each report. For CJ, returns come as separate 'correction' records with negative values, rather than changes to the original order. (3) Payment records: each network has its own payment record table since data formats differ.",
            requiredEntryIds: [
                ...findBySlug("biz-", "order-snapshots-and-corrections"),
                ...findBySlug("biz-", "order-status"),
            ],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-three-status-dimensions",
            question:
                "What is the difference between affiliate order status, internal order status, and manual status? Give examples of each.",
            expectedAnswer:
                "Affiliate Order Status reflects what the network reports: pending, new, approved, auto-approved, returned, declined, closed, locked, or mixed. Internal Order Status is TheFloorr's own calculation: if all items returned → internally returned; if network says closed/locked → internally approved; if still new/pending → stays pending. Manual Status is an admin override that forces internal status regardless of network data — used for data corrections, reconciliation, and edge cases the automated rules can't handle.",
            requiredEntryIds: findBySlug("biz-", "order-status"),
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-deprecated-features",
            question:
                "What features and naming conventions on TheFloorr are deprecated and should no longer be used?",
            expectedAnswer:
                "Deprecated items: (1) FRI (Fashion Retail Individual) and GPS (Guest Personal Shopper) are deprecated names for stylists — now called PSE (Personal Shopper Entrepreneur). (2) Looks and Consultations (Styling Sessions) features are deprecated and no longer available. (3) PSE's direct communication with clients through the platform is deprecated. (4) The term 'rejected' for order status is deprecated — use 'returned' instead.",
            requiredEntryIds: [
                "supersession-stylist-name-new",
                "supersession-looks-new",
                "supersession-rejected-new",
            ],
            excludedEntryIds: [
                "supersession-stylist-name-old",
                "supersession-looks-old",
                "supersession-rejected-old",
            ],
            difficulty: "hard",
        },
        {
            id: "q-pse-payment-stages",
            question:
                "Walk through all the stages a PSE payment goes through from order to bank account.",
            expectedAnswer:
                "The stages are: (1) Order is approved by the affiliate network. (2) The affiliate network pays TheFloorr the commission on its own schedule (typically monthly). (3) Commission is calculated for the stylist (default 80% of order commission). (4) An admin or the system approves the commission for payment, creating an 'approved payment' record. (5) Multiple approved payments are batched into a single Revolut payment draft. (6) The draft moves through states: approved, created in Revolut, sent, then completed or failed. (7) The stylist receives the money via bank transfer through Revolut. If VAT-registered in the UK, VAT is added on top.",
            requiredEntryIds: findBySlug("biz-", "three-payment-streams"),
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-manual-adjustments",
            question: "Why are manual adjustments necessary in TheFloorr's order system?",
            expectedAnswer:
                "Manual adjustments are necessary because: (1) Data import errors from affiliate networks. (2) Network API gaps where certain data is not automatically reported. (3) Reconciliation adjustments when actual payments don't match expected amounts. (4) Edge cases the automated rules cannot handle. Admins can manually override the internal status, payment statuses for all three streams, commission amounts, and stylist balance.",
            requiredEntryIds: findBySlug("biz-", "manual-adjustments"),
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-product-partitioning",
            question:
                "How are products organized in TheFloorr's catalogue across regions and genders?",
            expectedAnswer:
                "Products are organised into sixteen search partitions based on gender (female, male) and region (UK, US, EU, Rest of World), with separate partitions for full-price and sale items. This means the same product may appear with different pricing depending on the customer's region. 2 genders x 4 regions x 2 price types = 16 partitions.",
            requiredEntryIds: findBySlug("biz-", "regional-and-gender-partitioning"),
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-return-flow-network",
            question:
                "How does the affiliate network handle commission refunds when a customer returns an item?",
            expectedAnswer:
                "Networks do not send money back to TheFloorr for returns. Instead, they deduct the returned commission from future payments. For example, if TheFloorr was owed 100 pounds in commission next month but a previous order had a 20 pound return after network payment, the network would pay 80 pounds. The refund status is marked as pending if return happened after the affiliate network already paid commission to TheFloorr.",
            requiredEntryIds: findBySlug("biz-", "returns-and-refunds"),
            excludedEntryIds: [],
            difficulty: "hard",
        },
    ];
}

export function collectTheFloorrData(): Dataset {
    console.log("[Phase 0] Collecting TheFloorr business dataset from markdown files...\n");

    const businessMd = readFileSync(join(DATASETS_DIR, "thefloorr-business.md"), "utf-8");

    const businessSections = parseMarkdownSections(businessMd);

    const entries: DatasetEntry[] = [];

    // Process business sections
    for (const section of businessSections) {
        const slug = slugify(section.heading);
        const meta = BUSINESS_ENTRY_META[slug];
        const id = `biz-${slug}`;

        entries.push({
            id,
            content: `${section.heading}\n\n${section.content}`,
            expectedClassification: meta?.classification ?? "fact",
            ...(meta?.relatedGroup ? { relatedGroup: meta.relatedGroup } : {}),
        });
    }

    // Add manual supersession entries
    const manualEntries = getManualEntries();
    entries.push(...manualEntries);

    // Build entry ID list for question generation
    const entryIds = entries.map((e) => e.id);
    const questions = getVerificationQuestions(entryIds);

    console.log(`  Business sections: ${businessSections.length}`);
    console.log(`  Manual entries: ${manualEntries.length}`);
    console.log(
        `\n[Phase 0] Collected ${entries.length} entries, ${questions.length} verification questions`,
    );

    const dataset: Dataset = { entries, questions };
    writeDataset(dataset);

    return dataset;
}

// Run directly
if (import.meta.main) {
    collectTheFloorrData();
}
