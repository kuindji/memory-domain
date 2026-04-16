import type { ClaimId, RetrievalMode } from "../src/types.js";

export type EvalQuery = {
    name: string;
    probes: string[];
    naturalQuery: string;
    ideal: ClaimId[];
    mode?: RetrievalMode;
};

export const queriesTier1: EvalQuery[] = [
    {
        name: "current residence",
        probes: ["Alex's current residence", "where Alex lives now"],
        naturalQuery: "Where does Alex live right now?",
        ideal: ["loc_seattle", "house_seattle"],
    },
    {
        name: "college education",
        probes: ["Alex's university", "Alex's degree", "Alex college"],
        naturalQuery: "Where did Alex go to college?",
        ideal: ["edu_mit", "edu_grad", "edu_thesis", "prof_lin"],
    },
    {
        name: "current job",
        probes: ["Alex's current employer", "Alex's job title"],
        naturalQuery: "What is Alex's current job?",
        ideal: ["job_msft"],
    },
    {
        name: "marriage and partner",
        probes: ["Alex's spouse", "Alex's wedding"],
        naturalQuery: "Tell me about Alex's marriage to Sam",
        ideal: ["marry_sam", "date_sam", "met_sam"],
    },
    {
        name: "family",
        probes: ["Alex's family", "Alex's children", "Alex's spouse"],
        naturalQuery: "Who is in Alex's family?",
        ideal: ["marry_sam", "child_lily", "adopt_dog"],
    },
    {
        name: "google work artifacts",
        probes: ["Alex's work at Google", "Alex's achievements at Google"],
        naturalQuery: "What did Alex accomplish at Google?",
        ideal: ["patent_search", "award_eng", "job_google_search"],
    },
    {
        name: "hobbies",
        probes: ["Alex's hobbies", "what Alex does for fun"],
        naturalQuery: "What does Alex do for fun?",
        ideal: [
            "hobby_hike",
            "hobby_guitar",
            "hobby_records",
            "hobby_marathon",
            "hobby_thai",
            "hobby_coffee",
            "hobby_chess",
            "hobby_cycling",
        ],
    },
    {
        name: "first child",
        probes: ["Alex's first child", "Alex's daughter"],
        naturalQuery: "Does Alex have any children?",
        ideal: ["child_lily"],
    },
    {
        name: "speaking engagements",
        probes: ["Alex's talks", "conferences Alex spoke at"],
        naturalQuery: "Has Alex given any conference talks?",
        ideal: ["speak_qcon"],
    },
    {
        name: "post-acquisition outcome",
        probes: ["after the startup acquisition", "Alex's role after the acquisition"],
        naturalQuery: "What happened to Alex after the startup was acquired?",
        ideal: ["job_msft", "loc_seattle", "equity_acquisition", "house_seattle"],
    },
    {
        name: "as-of: where alex lived in 2015",
        probes: ["Alex's residence", "where Alex lives"],
        naturalQuery: "Where did Alex live mid-career?",
        ideal: ["loc_paloalto"],
        mode: { kind: "asOf", at: 15 },
    },
    {
        name: "as-of: alex job before microsoft",
        probes: ["Alex's job", "Alex's company"],
        naturalQuery: "What was Alex's job before Microsoft?",
        ideal: ["job_startup_cto", "job_google_search"],
        mode: { kind: "asOf", at: 15 },
    },
];
