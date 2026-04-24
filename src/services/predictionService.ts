import { GoogleGenAI, Type } from "@google/genai";
import { StudentProfile, PredictionResponse } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function predictUniversities(profile: StudentProfile): Promise<PredictionResponse> {
  const prompt = `
    TODAY'S DATE: April 24, 2026.
    You are an expert global educational consultant for MBBS abroad. All data you provide must be relevant for the 2026 academic intake.
    
    A student with the following profile is seeking admission:
    - NEET Rank: ${profile.neetRank}
    - NEET Score: ${profile.neetScore}
    - Annual Budget (USD): ${profile.budgetInUSD || 'Any'}
    - Preferred Countries: ${profile.preferredCountries?.join(', ') || 'Any'}
    - Critical Preferences: ${profile.otherPreferences || 'None'}

    STRICT INSTRUCTION ON PREFERENCES:
    If the student mentions "Indian food", "Indian mess", or "Indian community", PRIORITIZE universities known for having on-campus Indian messes or a high density of Indian students (e.g., certain universities in Russia, Philippines, or Georgia).

    Predict the TOP 10 BEST Universities for this student for the 2026 intake. 
    ${profile.preferredCountries && profile.preferredCountries.length > 0 
      ? `STRICT REQUIREMENT: Only suggest universities located in one of these countries: ${profile.preferredCountries.join(', ')}.` 
      : 'Focus on popular destinations like Russia, Uzbekistan, Kazakhstan, Georgia, Philippines, Kyrgyzstan, etc.'}
    
    For each university, provide detailed information about:
    - Total Program Cost (approx. for 5/6 years)
    - Tuition Fee per Year
    - NMC / India Recognition Status (Verified for Indian students)
    - Clinical Exposure (Hospital quality)
    - Safety + Indian Student Support (Community presence)
    - ROI Score (1-10)
    - Final Category (Best For: Budget / Premium / Easy Admission)
    - Key medical specializations or research strengths (e.g., Cardiology, Surgery, etc.)
    - Continent (e.g., Europe, Asia, Americas, Africa)

    Ensure suggestions offer high-quality English-medium MBBS.
    Focus on universities where an Indian student with this rank/score has a high chance of admission.

    Provide the output in JSON format matching the specified schema.
  `;

  try {
    // Phase 1: Grounded Research
    const researchResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Research the TOP 10 BEST Universities for an Indian student for the 2026 intake.
      STRICT DESTINATION: ${profile.destinationType === 'India' ? 'ONLY search for universities INSIDE INDIA.' : 'ONLY search for universities OUTSIDE India (Global).'}
      
      Student Profile:
      - AIR Rank: ${profile.neetRank}
      - NEET Score: ${profile.neetScore}
      - Category: ${profile.category || 'General'}
      - Domicile State: ${profile.domicileState || 'Any'}
      - Total Budget: ${profile.budgetInUSD}
      
      ${profile.destinationType === 'India' ? 
        'Look for Govt, Private, and Deemed colleges matching the Cutoff trends for the student\'s Rank, Category, and Domicile State.' : 
        `Look for universities in ${profile.preferredCountries?.join(', ') || 'Global regions'} including tuition, FMGE pass rates, and English medium stability.`}
      
      Verify Indian food/mess facilities if mentioned: ${profile.otherPreferences}.`,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const researchData = researchResponse.text;

    // Phase 2: Structured Formatting
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Based on this research data: \n\n ${researchData} \n\n Format into TOP 10 BEST Universities recommendation JSON:
      - Destination: ${profile.destinationType}
      - Rank/Score: ${profile.neetRank} / ${profile.neetScore}
      - Category/State: ${profile.category} / ${profile.domicileState}
      - Budget: ${profile.budgetInUSD}

      STRICT RULES:
      1. If Destination is India, ONLY include Indian universities. 
      2. QUOTA LOGIC (INDIA): For each college, specify if it's "All India Quota (AIQ)", "State Quota (SQ)", or "Management/Deemed". SQ is 85% seats for students with Domicile State: ${profile.domicileState}. AIQ is 15% seats for any state.
      3. CATEGORY IMPACT: Factor in the ${profile.category} category for cutoff research. SC/ST/OBC usually have significantly lower cutoffs than General.
      4. FEE REALISM (INDIA): Govt fees are ₹50k-4L total. Private fees are ₹8L-25L PER YEAR. Deemed are ₹15L-30L PER YEAR. Use ACTUAL INR values.
      5. FEE REALISM (ABROAD): Typically $3,000-$7,000 USD per year. 
      6. Total Cost must include all years (usually 5.5 years for India/Abroad mixed).
      7. Ensure clinicalExposure and safetyAndSupport are realistic based on verified hospital data.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["universities", "analysis"],
          properties: {
            universities: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["name", "country", "continent", "annualTuitionFee", "totalProgramCost", "totalDurationYears", "mediumOfInstruction", "neetRequirement", "nmcRecognitionStatus", "globalRank", "rankingSource", "rankingYear", "clinicalExposure", "safetyAndSupport", "roiScore", "bestFor", "specializations", "reputationScore", "description"],
                properties: {
                  name: { type: Type.STRING },
                  country: { type: Type.STRING },
                  continent: { type: Type.STRING },
                  annualTuitionFee: { 
                    type: Type.STRING, 
                    description: "The annual tuition fee. For India, use INR (e.g. '₹12,00,000 INR'). For Abroad, use USD (e.g. '$5,000 USD')." 
                  },
                  totalProgramCost: { 
                    type: Type.STRING, 
                    description: "Total cost for the entire program in original currency." 
                  },
                  quota: { 
                    type: Type.STRING, 
                    description: "For India: 'State Quota (85%)', 'All India Quota (15%)', 'Management' or 'Deemed'. For Global: 'International Seat'." 
                  },
                  totalDurationYears: { type: Type.STRING },
                  mediumOfInstruction: { type: Type.STRING },
                  neetRequirement: { type: Type.STRING },
                  nmcRecognitionStatus: { type: Type.STRING, description: "NMC / India Recognition Status" },
                  globalRank: { type: Type.STRING },
                  rankingSource: { type: Type.STRING },
                  rankingYear: { type: Type.STRING },
                  clinicalExposure: { type: Type.STRING },
                  safetyAndSupport: { type: Type.STRING },
                  roiScore: { type: Type.STRING },
                  bestFor: { type: Type.STRING },
                  specializations: { 
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  },
                  reputationScore: { type: Type.STRING },
                  description: { type: Type.STRING }
                }
              }
            },
            analysis: { type: Type.STRING, description: "A detailed strategic analysis of the student's chances based on their Rank, Category, and Domicile. Mention specific quota advantages if applicable." }
          }
        }
      }
    });

    const result = JSON.parse(response.text || '{}') as PredictionResponse;
    return result;
  } catch (error) {
    console.error("Prediction error:", error);
    throw new Error("Failed to generate college predictions. Please check your inputs and try again.");
  }
}
