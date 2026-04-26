import { GoogleGenAI, Type } from "@google/genai";
import { StudentProfile, PredictionResponse } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function predictUniversities(profile: StudentProfile): Promise<PredictionResponse> {
  try {
    // Phase 1: Strategic Intelligence (Pro Model)
    // This phase selects the optimal 10 colleges based on complex cutoff/quota analysis.
    const strategicResponse = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: `You are a Senior Medical Admissions Strategist for the 2026 intake.
      STUDENT PROFILE:
      - NEET Rank: ${profile.neetRank}
      - NEET Score: ${profile.neetScore}
      - Category: ${profile.category || 'General'}
      - Domicile State: ${profile.domicileState || 'Any'}
      - Budget Selection: ${profile.budgetInUSD}
      - Destination: ${profile.destinationType}

      TASK:
      1. Provide a detailed, realistic Strategic Analysis (4-5 sentences). 
         - If score is < 600 and they want India, explain why Govt MBBS is impossible but BDS/AYUSH/Private is feasible.
         - Mention the impact of ${profile.category} category and ${profile.domicileState} quota.
      2. Identify the TOP 10 SPECIFIC Colleges that fit the ${profile.budgetInUSD} range and the student's score.
         - For India, specify the course: (MBBS), (BDS), or (BAMS).
         - For Global, focus on countries with high FMGE success.

      FORMAT: Respond with a JSON object:
      {
        "analysis": "...",
        "collegeList": ["College Name 1", "College Name 2", ...]
      }`,
      config: {
        responseMimeType: "application/json",
        tools: [{ googleSearch: {} }]
      }
    });

    const strategy = JSON.parse(strategicResponse.text || '{}');

    // Phase 2: Technical Enrichment (Flash Model)
    // This phase enriches the selected list with metadata points quickly.
    const enrichmentResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `For these 10 medical colleges: ${strategy.collegeList?.join(', ') || 'None'}
      
      ENRICH with technical data for an Indian student (2026 intake):
      - Destination: ${profile.destinationType}
      - User Rank/Score: ${profile.neetRank} / ${profile.neetScore}
      - Category: ${profile.category}
      
      STRICT DATA RULES:
      1. BUDGET: Ensure Total Cost fits within ${profile.budgetInUSD}. Unit: L means Lakhs INR.
      2. FEES: Use ACTUAL estimates including Hostel. For India, use INR.
      3. QUOTA: Specify 'State Quota (SQ)' or 'All India Quota (AIQ)'. SQ only if domicile is ${profile.domicileState}.
      4. SYNC: Map each college name provided in the list exactly.

      Return the final TOP 10 Universities recommendation JSON matching the schema.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["universities"],
          properties: {
            universities: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["name", "country", "continent", "annualTuitionFee", "totalProgramCost", "totalDurationYears", "mediumOfInstruction", "neetRequirement", "nmcRecognitionStatus", "globalRank", "clinicalExposure", "safetyAndSupport", "roiScore", "bestFor", "specializations", "reputationScore", "description"],
                properties: {
                  name: { type: Type.STRING },
                  country: { type: Type.STRING },
                  continent: { type: Type.STRING },
                  annualTuitionFee: { type: Type.STRING },
                  totalProgramCost: { type: Type.STRING },
                  quota: { type: Type.STRING },
                  totalDurationYears: { type: Type.STRING },
                  mediumOfInstruction: { type: Type.STRING },
                  neetRequirement: { type: Type.STRING },
                  nmcRecognitionStatus: { type: Type.STRING },
                  globalRank: { type: Type.STRING },
                  clinicalExposure: { type: Type.STRING },
                  safetyAndSupport: { type: Type.STRING },
                  roiScore: { type: Type.STRING },
                  bestFor: { type: Type.STRING },
                  specializations: { type: Type.ARRAY, items: { type: Type.STRING } },
                  reputationScore: { type: Type.STRING },
                  description: { type: Type.STRING }
                }
              }
            }
          }
        }
      }
    });

    const enrichedData = JSON.parse(enrichmentResponse.text || '{"universities": []}');

    return {
      universities: enrichedData.universities,
      analysis: strategy.analysis || "No analysis available."
    };
  } catch (error) {
    console.error("Prediction error:", error);
    throw new Error("Failed to generate college predictions. Please check your inputs and try again.");
  }
}
