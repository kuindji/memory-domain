import type { ClaimId, RetrievalMode } from "../src/types.js";

export type Turn = {
    probes: string[];
    naturalQuery: string;
    expectedClaimsAfterThisTurn: ClaimId[];
};

export type ConversationTrace = {
    name: string;
    description: string;
    mode?: RetrievalMode;
    turns: Turn[];
};

export const tracesTier1: ConversationTrace[] = [
    {
        name: "career arc",
        description:
            "Progressive narrowing onto Alex's professional history at MIT, Google, the startup, and Microsoft.",
        turns: [
            {
                probes: ["what Alex studied"],
                naturalQuery: "What did Alex study?",
                expectedClaimsAfterThisTurn: ["edu_mit", "edu_grad", "edu_thesis"],
            },
            {
                probes: ["where Alex worked first"],
                naturalQuery: "Where did Alex work first after college?",
                expectedClaimsAfterThisTurn: ["job_google_search", "patent_search", "award_eng"],
            },
            {
                probes: ["when Alex left Google", "Alex at the startup"],
                naturalQuery: "Did Alex change jobs after Google?",
                expectedClaimsAfterThisTurn: ["job_msft", "equity_acquisition", "speak_qcon"],
            },
            {
                probes: ["Alex's role at Microsoft"],
                naturalQuery: "What does Alex do at Microsoft?",
                expectedClaimsAfterThisTurn: ["job_msft"],
            },
        ],
    },
    {
        name: "family arc",
        description:
            "Building up Alex's relationship with Sam — meeting, dating, marriage, child, and the rescue dog.",
        turns: [
            {
                probes: ["Alex meeting Sam"],
                naturalQuery: "When did Alex meet Sam?",
                expectedClaimsAfterThisTurn: ["met_sam"],
            },
            {
                probes: ["Alex and Sam together"],
                naturalQuery: "When did they start dating?",
                expectedClaimsAfterThisTurn: ["met_sam", "date_sam"],
            },
            {
                probes: ["Alex Sam wedding"],
                naturalQuery: "Did Alex and Sam get married?",
                expectedClaimsAfterThisTurn: ["met_sam", "date_sam", "marry_sam"],
            },
            {
                probes: ["Alex children", "Alex Sam pets"],
                naturalQuery: "Do Alex and Sam have kids or pets?",
                expectedClaimsAfterThisTurn: ["child_lily", "adopt_dog"],
            },
        ],
    },
    {
        name: "location arc (asOf t=15)",
        description:
            "Tracing where Alex lived through different life stages, querying historical state.",
        mode: { kind: "asOf", at: 15 },
        turns: [
            {
                probes: ["where Alex grew up"],
                naturalQuery: "Where did Alex grow up?",
                expectedClaimsAfterThisTurn: ["loc_boston"],
            },
            {
                probes: ["Alex college years residence"],
                naturalQuery: "Where did Alex live during college?",
                expectedClaimsAfterThisTurn: ["loc_cambridge"],
            },
            {
                probes: ["Alex moved west coast"],
                naturalQuery: "When did Alex move to the west coast?",
                expectedClaimsAfterThisTurn: ["loc_sf", "loc_paloalto"],
            },
        ],
    },
];
