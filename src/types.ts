
export interface StudentProfile {
  neetRank: number;
  neetScore: number;
  budgetInUSD: number | string;
  preferredCountries?: string[];
  preferredContinents?: string[];
  preferredSpecializations?: string[];
  otherPreferences?: string;
  category?: string;
  domicileState?: string;
  destinationType?: 'India' | 'Global';
}

export interface University {
  name: string;
  country: string;
  continent: string; // e.g. "Europe", "Asia"
  annualTuitionFee: string;
  totalProgramCost: string; // e.g. "$35,000 Total"
  totalDurationYears: string;
  mediumOfInstruction: string;
  neetRequirement: string;
  nmcRecognitionStatus: string; // e.g. "Fully Recognized", "Verified"
  globalRank: string;
  rankingSource: string;
  rankingYear: string;
  clinicalExposure: string; // Quality of teaching hospitals
  safetyAndSupport: string; // Safety level + Indian student support
  roiScore: string; // ROI Score / Career Scope
  bestFor: string; // e.g. "Budget Friendly", "High Reputation", "Premium Choice"
  specializations: string[]; // e.g. ["Cardiology", "Neurology", "Surgery"]
  reputationScore: string;
  quota?: string; // e.g. "State Quota (85%)", "All India Quota (15%)", "Government", "Management"
  description: string;
}

export interface PredictionResponse {
  universities: University[];
  analysis: string;
}
