export type ClaimSpec = {
    id: string;
    text: string;
    validFrom: number;
    supersedes?: string;
};

export const tier1Alex: ClaimSpec[] = [
    { id: "loc_boston", text: "Alex grew up in Boston Massachusetts", validFrom: 0 },

    { id: "edu_mit", text: "Alex enrolled at MIT to study computer science", validFrom: 1 },
    {
        id: "loc_cambridge",
        text: "Alex lived in Cambridge during college",
        validFrom: 1,
        supersedes: "loc_boston",
    },
    { id: "met_sam", text: "Alex met Sam during freshman year at MIT", validFrom: 1 },

    { id: "internship_ibm", text: "Alex did a summer internship at IBM Research", validFrom: 2 },
    { id: "prof_lin", text: "Alex's MIT advisor was Professor Lin", validFrom: 2 },
    { id: "hobby_hike", text: "Alex took up hiking on weekends", validFrom: 2 },
    { id: "hobby_guitar", text: "Alex started learning acoustic guitar", validFrom: 2 },
    { id: "hobby_records", text: "Alex began collecting vintage vinyl records", validFrom: 2 },

    { id: "date_sam", text: "Alex and Sam started dating", validFrom: 3 },

    {
        id: "edu_grad",
        text: "Alex graduated from MIT with a computer science degree",
        validFrom: 4,
    },
    { id: "edu_thesis", text: "Alex's senior thesis was on distributed systems", validFrom: 4 },
    { id: "job_google", text: "Alex joined Google as a junior software engineer", validFrom: 4 },
    {
        id: "loc_sf",
        text: "Alex moved to San Francisco for the Google job",
        validFrom: 4,
        supersedes: "loc_cambridge",
    },

    { id: "hobby_marathon", text: "Alex started running marathons", validFrom: 5 },
    { id: "hobby_thai", text: "Alex's favorite cuisine became Thai food", validFrom: 5 },

    {
        id: "job_google_senior",
        text: "Alex was promoted to senior software engineer at Google",
        validFrom: 6,
        supersedes: "job_google",
    },
    { id: "loc_paloalto", text: "Alex bought a house in Palo Alto California", validFrom: 6 },

    { id: "job_google_search", text: "Alex moved to the Search team at Google", validFrom: 7 },
    { id: "gym_paloalto", text: "Alex joined a gym in Palo Alto", validFrom: 7 },

    { id: "marry_sam", text: "Alex and Sam got married", validFrom: 8 },
    {
        id: "patent_search",
        text: "Alex filed a patent on search ranking algorithms at Google",
        validFrom: 8,
    },
    { id: "hobby_coffee", text: "Alex began roasting coffee at home", validFrom: 8 },

    {
        id: "award_eng",
        text: "Alex received the Outstanding Engineer award at Google",
        validFrom: 9,
    },
    { id: "adopt_dog", text: "Alex and Sam adopted a rescue dog named Max", validFrom: 9 },

    {
        id: "job_startup",
        text: "Alex left Google to join a startup as engineering lead",
        validFrom: 10,
        supersedes: "job_google_senior",
    },
    { id: "car_tesla", text: "Alex bought a Tesla Model 3", validFrom: 10 },

    {
        id: "child_lily",
        text: "Alex and Sam had their first child a daughter named Lily",
        validFrom: 11,
    },
    {
        id: "conf_neurips",
        text: "Alex started attending the NeurIPS conference annually",
        validFrom: 11,
    },

    {
        id: "job_startup_cto",
        text: "Alex was promoted to CTO at the startup",
        validFrom: 12,
        supersedes: "job_startup",
    },
    { id: "hobby_chess", text: "Alex took up competitive chess", validFrom: 12 },

    {
        id: "volunteer_bootcamp",
        text: "Alex began volunteering at a coding bootcamp on weekends",
        validFrom: 13,
    },

    { id: "hobby_cycling", text: "Alex took up road cycling", validFrom: 14 },

    {
        id: "speak_qcon",
        text: "Alex gave a talk at QCon about scaling search systems",
        validFrom: 15,
    },

    {
        id: "job_msft",
        text: "Alex became Director of Engineering at Microsoft after the startup acquisition",
        validFrom: 18,
        supersedes: "job_startup_cto",
    },
    {
        id: "loc_seattle",
        text: "Alex relocated to Seattle for the Microsoft role",
        validFrom: 18,
        supersedes: "loc_paloalto",
    },
    {
        id: "equity_acquisition",
        text: "Alex received significant equity from the startup acquisition",
        validFrom: 18,
    },

    { id: "house_seattle", text: "Alex bought a house in Seattle", validFrom: 19 },
];
