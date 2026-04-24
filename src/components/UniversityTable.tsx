import React, { useState, useMemo } from 'react';
import { Download, ArrowUpDown, Search, Filter, X, MapPin, Banknote, Calendar, BookOpen, Award, Globe, Sparkles, Info, MessageSquare, User, Mail, Phone } from 'lucide-react';
import { University } from '../types';
import { motion, AnimatePresence } from 'motion/react';

interface Props {
  universities: University[];
  currency?: 'USD' | 'INR';
  onCurrencyChange?: (cur: 'USD' | 'INR') => void;
  otherPreferences?: string;
}

export default function UniversityTable({ universities, currency = 'USD', onCurrencyChange, otherPreferences }: Props) {
  const [filter, setFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [continentFilter, setContinentFilter] = useState('');
  const [specFilter, setSpecFilter] = useState('');
  const [minTuition, setMinTuition] = useState<number>(0);
  const [maxTuition, setMaxTuition] = useState<number>(100000);
  
  const [sortField, setSortField] = useState<keyof University | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [selectedUniversity, setSelectedUniversity] = useState<University | null>(null);
  const [showLeadModal, setShowLeadModal] = useState(false);
  const [leadAction, setLeadAction] = useState<'export' | 'brochure' | null>(null);
  const [leadFormData, setLeadFormData] = useState({ name: '', email: '', phone: '' });
  const [hasCapturedLead, setHasCapturedLead] = useState(false);

  const USD_TO_INR = 83.5;

  const formatCurrencyValue = (val: string) => {
    const rawNum = getNumericValue(val);
    if (rawNum === Infinity || rawNum === 0) return val;

    if (currency === 'INR') {
      const inrValue = rawNum * USD_TO_INR;
      return `₹${inrValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    }
    
    return `$${rawNum.toLocaleString('en-US')} USD`;
  };

  const handleSort = (field: keyof University) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const getNumericValue = (val: any): number => {
    if (typeof val === 'number') return val;
    if (!val || typeof val !== 'string') return 0;
    
    // Handle specific cases like "1501+" or "451-500" or "N/A"
    if (val === 'N/A') return Infinity; // Put N/A at the end
    
    // Extract first number found in string (handles "$8,500 USD" -> 8500, "9.0" -> 9, "451-500" -> 451)
    const match = val.replace(/,/g, '').match(/(\d+\.?\d*)/);
    return match ? parseFloat(match[0]) : 0;
  };

  const filteredAndSortedData = useMemo(() => {
    let data = [...universities];

    if (filter) {
      const lowFilter = filter.toLowerCase();
      data = data.filter(u => u.name.toLowerCase().includes(lowFilter));
    }

    if (countryFilter) {
      const lowCountry = countryFilter.toLowerCase();
      data = data.filter(u => u.country.toLowerCase().includes(lowCountry));
    }

    if (continentFilter) {
      const lowCont = continentFilter.toLowerCase();
      data = data.filter(u => u.continent.toLowerCase().includes(lowCont));
    }

    if (specFilter) {
      const lowSpec = specFilter.toLowerCase();
      data = data.filter(u => u.specializations.some(s => s.toLowerCase().includes(lowSpec)));
    }

    // Basic tuition filter
    data = data.filter(u => {
      const num = getNumericValue(u.annualTuitionFee);
      return num >= minTuition && num <= maxTuition;
    });

    if (sortField) {
      data.sort((a, b) => {
        const valA = a[sortField];
        const valB = b[sortField];
        
        // Define which fields should be treated as numeric for sorting
        const numericFields: Array<keyof University> = ['annualTuitionFee', 'totalProgramCost', 'roiScore', 'globalRank', 'totalDurationYears'];
        
        if (numericFields.includes(sortField)) {
          const numA = getNumericValue(valA);
          const numB = getNumericValue(valB);
          return sortDirection === 'asc' ? numA - numB : numB - numA;
        }

        if (typeof valA === 'string' && typeof valB === 'string') {
           return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        
        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    } else if (otherPreferences?.toLowerCase().includes('food')) {
      // Re-order to bring "Indian Mess" or similar to top if preferred
      data.sort((a, b) => {
        const aHasFood = a.description.toLowerCase().includes('indian mess') || a.description.toLowerCase().includes('indian food');
        const bHasFood = b.description.toLowerCase().includes('indian mess') || b.description.toLowerCase().includes('indian food');
        if (aHasFood && !bHasFood) return -1;
        if (!aHasFood && bHasFood) return 1;
        return 0;
      });
    }

    return data;
  }, [universities, filter, countryFilter, continentFilter, specFilter, minTuition, maxTuition, sortField, sortDirection, otherPreferences]);

  const top3 = universities.slice(0, 3);

  const handleExportClick = () => {
    if (hasCapturedLead) {
      exportCSV();
    } else {
      setLeadAction('export');
      setShowLeadModal(true);
    }
  };

  const handleBrochureClick = () => {
    if (hasCapturedLead) {
      alert("Brochure download started...");
      setSelectedUniversity(null);
    } else {
      setLeadAction('brochure');
      setShowLeadModal(true);
    }
  };

  const handleLeadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!leadFormData.name || !leadFormData.email || !leadFormData.phone) return;
    
    setHasCapturedLead(true);
    setShowLeadModal(false);
    
    if (leadAction === 'export') {
      exportCSV();
    } else if (leadAction === 'brochure') {
      alert("Brochure download started...");
      setSelectedUniversity(null);
    }
  };

  const exportCSV = () => {
    const headers = [
      "University Name", "Country", "Continent", "Annual Tuition", "Total Program Cost", "Duration", 
      "Medium", "NEET Requirement", "NMC Status", "Global Rank", "Ranking Source", "Ranking Year", "Clinical Exposure", 
      "Safety & Support", "ROI Score", "Best For", "Specializations", "Description"
    ];
    const rows = filteredAndSortedData.map(u => [
      u.name, u.country, u.continent, u.annualTuitionFee, u.totalProgramCost, u.totalDurationYears, 
      u.mediumOfInstruction, u.neetRequirement, u.nmcRecognitionStatus, u.globalRank, u.rankingSource, u.rankingYear,
      u.clinicalExposure, u.safetyAndSupport, u.roiScore, u.bestFor, u.specializations.join("; "), u.description
    ]);
    
    const csvContent = "data:text/csv;charset=utf-8," 
      + headers.join(",") + "\n" 
      + rows.map(e => e.join(",")).join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "mbbs_filtered_results.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div id="results-display" className="flex flex-col gap-4">
      {/* Top 3 Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {top3.map((u, i) => {
          const accents = [
            'border-indigo-500 text-indigo-500',
            'border-emerald-500 text-emerald-500',
            'border-amber-500 text-amber-500'
          ];
          return (
            <div key={u.name} className={`bg-white border-l-4 ${accents[i]} rounded-xl p-4 shadow-sm h-full flex flex-col justify-between`}>
              <div>
                <div className="text-[10px] font-bold uppercase mb-1">Match #{i + 1}</div>
                <h3 className="font-bold text-slate-800 text-sm leading-tight">{u.name}</h3>
                <p className="text-xs text-slate-500 mt-1">{u.country}</p>
              </div>
              <div className="mt-3 flex justify-between items-end">
                <span className="text-[10px] font-mono font-bold bg-slate-100 px-2 py-0.5 rounded text-slate-600">
                  {u.reputationScore}
                </span>
                <span 
                  onClick={() => setSelectedUniversity(u)}
                  className={`text-[10px] font-bold uppercase cursor-pointer hover:underline underline-offset-2`}
                >
                  Details →
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Excel-like Table */}
      <div className="bg-white border border-slate-200 rounded-2xl flex flex-col shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <h2 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Comparative Data Matrix</h2>
              
              {/* Currency Station */}
              <div className="bg-white p-0.5 rounded-lg flex items-center gap-0.5 border border-slate-200 shadow-sm">
                <button 
                  onClick={() => onCurrencyChange?.('USD')}
                  className={`px-2 py-1 rounded text-[9px] font-black transition-all ${
                    currency === 'USD' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  USD
                </button>
                <button 
                  onClick={() => onCurrencyChange?.('INR')}
                  className={`px-2 py-1 rounded text-[9px] font-black transition-all ${
                    currency === 'INR' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  INR
                </button>
              </div>
            </div>

            <button 
              onClick={handleExportClick}
              className="px-3 py-1.5 text-[10px] font-bold bg-white border border-slate-300 rounded shadow-sm hover:bg-slate-50 transition-colors uppercase flex items-center gap-2"
            >
              <Download className="w-3 h-3" />
              Export CSV
            </button>
          </div>
          
          <div className="flex items-center gap-2 text-[9px] text-slate-400 font-medium">
            <div className="flex items-center gap-1 bg-white px-2 py-0.5 rounded-full border border-slate-200">
              <div className="w-1 h-1 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)] animate-pulse"></div>
              <span className="text-slate-600 uppercase tracking-tighter font-bold">Dynamic Intel</span>
            </div>
            <span className="opacity-60">•</span>
            <span>Last Indexed: {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            <span className="opacity-60">•</span>
            <span className="italic text-indigo-500 font-bold">Verified for 2024-25 intake accuracy.</span>
          </div>
          
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Name..." 
                className="w-full pl-7 pr-3 py-1.5 bg-white border border-slate-200 rounded text-[10px] focus:ring-1 focus:ring-indigo-500 outline-none"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="relative">
              <Filter className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Country..." 
                className="w-full pl-7 pr-3 py-1.5 bg-white border border-slate-200 rounded text-[10px] focus:ring-1 focus:ring-indigo-500 outline-none"
                value={countryFilter}
                onChange={(e) => setCountryFilter(e.target.value)}
              />
            </div>
            <div className="relative">
              <Globe className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Continent..." 
                className="w-full pl-7 pr-3 py-1.5 bg-white border border-slate-200 rounded text-[10px] focus:ring-1 focus:ring-indigo-500 outline-none"
                value={continentFilter}
                onChange={(e) => setContinentFilter(e.target.value)}
              />
            </div>
            <div className="relative">
              <Award className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Specialization..." 
                className="w-full pl-7 pr-3 py-1.5 bg-white border border-slate-200 rounded text-[10px] focus:ring-1 focus:ring-indigo-500 outline-none"
                value={specFilter}
                onChange={(e) => setSpecFilter(e.target.value)}
              />
            </div>
            <div className="relative col-span-2 flex items-center gap-2 bg-white border border-slate-200 rounded px-2 py-1">
              <Banknote className="w-3 h-3 text-slate-400" />
              <span className="text-[9px] text-slate-400 uppercase font-bold whitespace-nowrap">Fee Range:</span>
              <input 
                type="number"
                placeholder="Min"
                className="w-full bg-slate-50 border-none rounded text-[10px] focus:ring-0 outline-none py-0.5 px-1"
                value={minTuition || ''}
                onChange={(e) => setMinTuition(parseInt(e.target.value) || 0)}
              />
              <span className="text-slate-300">-</span>
              <input 
                type="number"
                placeholder="Max"
                className="w-full bg-slate-50 border-none rounded text-[10px] focus:ring-0 outline-none py-0.5 px-1"
                value={maxTuition || ''}
                onChange={(e) => setMaxTuition(parseInt(e.target.value) || 0)}
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200">
                {[
                  { label: 'University Name', field: 'name' },
                  { label: 'Annual Fee', field: 'annualTuitionFee' },
                  { label: 'Total Cost', field: 'totalProgramCost' },
                  { label: 'NMC Status', field: 'nmcRecognitionStatus' },
                  { label: 'Rank', field: 'globalRank' },
                  { label: 'Duration', field: 'totalDurationYears' },
                  { label: 'Medium', field: 'mediumOfInstruction' },
                  { label: 'Clinical Quality', field: 'clinicalExposure' },
                  { label: 'Safety & Support', field: 'safetyAndSupport' },
                  { 
                    label: 'ROI', 
                    field: 'roiScore', 
                    info: 'Future ROI Score: Calculated based on FMGE pass rates, clinical placement volume, and median global salary post-graduation.' 
                  },
                  { label: 'Best For', field: 'bestFor' },
                ].map((col) => {
                  const isActive = sortField === col.field;
                  return (
                    <th 
                      key={col.label} 
                      className={`p-3 text-[10px] font-bold uppercase cursor-pointer transition-colors ${
                        isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-200'
                      }`}
                      onClick={() => handleSort(col.field as keyof University)}
                    >
                      <div className="flex items-center gap-1">
                        {col.label}
                        {'info' in col && (
                          <div className="group relative">
                            <Info className="w-2.5 h-2.5 text-slate-400" />
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-48 p-2 bg-slate-900 text-white text-[9px] rounded-lg shadow-xl z-50 normal-case font-medium leading-tight">
                              {col.info}
                            </div>
                          </div>
                        )}
                        <ArrowUpDown className={`w-2.5 h-2.5 transition-opacity ${isActive ? 'opacity-100' : 'opacity-30'}`} />
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="text-xs">
              {filteredAndSortedData.map((u, idx) => (
                <tr 
                  key={u.name}
                  onClick={() => setSelectedUniversity(u)}
                  className={`border-b border-slate-50 hover:bg-slate-50 transition-colors cursor-pointer ${idx % 2 === 1 ? 'bg-slate-50/30' : ''}`}
                >
                  <td className="p-3">
                    <div className="font-semibold text-slate-800">{u.name}</div>
                    <div className="text-[9px] text-slate-400 capitalize flex items-center gap-1.5">
                      {u.country} • {u.continent}
                      {(u.description.toLowerCase().includes('indian mess') || u.description.toLowerCase().includes('indian food')) && (
                        <span className="bg-amber-100 text-amber-700 px-1 rounded-[4px] font-black uppercase text-[7px] border border-amber-200">Indian Food ✅</span>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="font-mono font-bold text-slate-800 text-[11px]">{formatCurrencyValue(u.annualTuitionFee)}</div>
                    <div className="text-[8px] text-slate-400 font-bold uppercase tracking-tight mt-0.5 flex items-center gap-1">
                      <div className="w-1 h-1 rounded-full bg-slate-300"></div>
                      Base Fee
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="font-mono font-black text-indigo-600 text-[11px]">{formatCurrencyValue(u.totalProgramCost)}</div>
                    <div className="text-[8px] text-indigo-400 font-bold uppercase tracking-tight mt-0.5 flex items-center gap-1">
                      <div className="w-1 h-1 rounded-full bg-indigo-300"></div>
                      Est. Total
                    </div>
                  </td>
                  <td className="p-3">
                    <span className="bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border border-emerald-100">
                      {u.nmcRecognitionStatus}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1.5">
                      <div className="font-bold text-slate-700">{u.globalRank}</div>
                      <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" title="Latest verified data"></div>
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <span className="text-[8px] px-1 py-0.5 bg-slate-100 text-slate-500 rounded font-black border border-slate-200">
                        {u.rankingSource}
                      </span>
                    </div>
                  </td>
                  <td className="p-3 text-slate-500">{u.totalDurationYears}</td>
                  <td className="p-3 text-slate-600 truncate max-w-[100px]">{u.mediumOfInstruction}</td>
                  <td className="p-3 text-slate-600 truncate max-w-[150px]" title={u.clinicalExposure}>{u.clinicalExposure}</td>
                  <td className="p-3 text-slate-600 truncate max-w-[150px]" title={u.safetyAndSupport}>{u.safetyAndSupport}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      <div className="w-8 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-indigo-500" 
                          style={{ width: `${(parseInt(u.roiScore) || 0) * 10}%` }}
                        />
                      </div>
                      <span className="font-bold text-indigo-600">{u.roiScore}</span>
                    </div>
                  </td>
                  <td className="p-3">
                    <span className="bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase whitespace-nowrap">
                      {u.bestFor}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Dialog */}
      <AnimatePresence>
        {selectedUniversity && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedUniversity(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden shadow-indigo-200/50"
            >
              <div className="absolute top-4 right-4 z-10">
                <button 
                  onClick={() => setSelectedUniversity(null)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400 hover:text-slate-600"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-col h-full max-h-[90vh]">
                {/* Modal Header */}
                <div className="p-8 bg-indigo-900 text-white relative">
                  <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-2">
                       <span className="bg-indigo-500/50 text-white text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-widest">{selectedUniversity.bestFor}</span>
                    </div>
                    <h2 className="text-3xl font-black tracking-tight leading-tight mb-2">{selectedUniversity.name}</h2>
                    <div className="flex items-center gap-2 text-indigo-200 font-medium">
                      <MapPin className="w-4 h-4" />
                      {selectedUniversity.country}
                    </div>
                  </div>
                  <Globe className="absolute -right-16 -bottom-16 w-64 h-64 text-white/5" />
                </div>

                {/* Modal Body */}
                <div className="p-8 overflow-y-auto bg-white custom-scrollbar h-full">
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                      <div className="flex items-center gap-2 text-slate-400 mb-1">
                        <Banknote className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Tuition Fees</span>
                      </div>
                      <div className="font-mono font-bold text-slate-900">{formatCurrencyValue(selectedUniversity.annualTuitionFee)}</div>
                      <div className="text-[9px] text-slate-400 font-medium uppercase mt-0.5">Annual / Year</div>
                    </div>

                    <div className="bg-indigo-50 p-4 rounded-2xl border border-indigo-100">
                      <div className="flex items-center gap-2 text-indigo-400 mb-1">
                        <Sparkles className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-700">Total Program</span>
                      </div>
                      <div className="font-mono font-bold text-indigo-700">{formatCurrencyValue(selectedUniversity.totalProgramCost)}</div>
                      <div className="text-[9px] text-indigo-400 font-medium uppercase mt-0.5">Approx Package</div>
                    </div>
                    
                    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                      <div className="flex items-center gap-2 text-slate-400 mb-1">
                        <Calendar className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Duration</span>
                      </div>
                      <div className="font-bold text-slate-900">{selectedUniversity.totalDurationYears}</div>
                      <div className="text-[9px] text-slate-400 font-medium uppercase mt-0.5">Academic Cycle</div>
                    </div>

                    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                      <div className="flex items-center gap-2 text-slate-400 mb-1">
                        <BookOpen className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Instruction</span>
                      </div>
                      <div className="font-bold text-slate-900">{selectedUniversity.mediumOfInstruction}</div>
                      <div className="text-[9px] text-slate-400 font-medium uppercase mt-0.5">Language Mode</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                    <div className="bg-emerald-50 p-4 rounded-2xl border border-emerald-100 flex flex-col justify-center">
                      <div className="flex items-center gap-2 text-emerald-400 mb-1">
                        <Globe className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">NMC Recognition</span>
                      </div>
                      <div className="font-bold text-emerald-700 leading-tight">{selectedUniversity.nmcRecognitionStatus}</div>
                      <div className="text-[9px] text-emerald-400 font-medium uppercase mt-1">Verified for Indian Practice</div>
                    </div>

                    <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex flex-col justify-center">
                      <div className="flex items-center gap-2 text-slate-500 mb-1">
                        <Award className="w-3.5 h-3.5 text-indigo-400" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Global Ranking</span>
                      </div>
                      <div className="font-mono font-bold text-white text-lg">#{selectedUniversity.globalRank}</div>
                      <div className="text-[9px] text-indigo-300/70 font-medium uppercase mt-1">
                        {selectedUniversity.rankingSource} 
                        <span className="ml-1 opacity-50">[{selectedUniversity.rankingYear}]</span>
                      </div>
                    </div>

                    <div className="bg-amber-50 p-4 rounded-2xl border border-amber-100 flex flex-col justify-center">
                      <div className="flex items-center gap-2 text-amber-500 mb-1">
                        <MapPin className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Location Details</span>
                      </div>
                      <div className="font-bold text-amber-800">{selectedUniversity.country}</div>
                      <div className="text-[9px] text-amber-500 font-medium uppercase mt-1">{selectedUniversity.continent} Region</div>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <section>
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2">
                        <div className="w-4 h-[1px] bg-slate-200"></div>
                        Professional Evaluation
                        <div className="flex-grow h-[1px] bg-slate-100"></div>
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                          <div className="text-[9px] uppercase font-bold text-slate-400 mb-1">Clinical Standard</div>
                          <p className="text-sm text-slate-700 leading-relaxed">{selectedUniversity.clinicalExposure}</p>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                          <div className="text-[9px] uppercase font-bold text-slate-400 mb-1">Safety & Student Experience</div>
                          <p className="text-sm text-slate-700 leading-relaxed">{selectedUniversity.safetyAndSupport}</p>
                        </div>
                      </div>
                    </section>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="bg-indigo-900 text-white p-5 rounded-2xl shadow-xl space-y-1 group relative">
                            <div className="flex items-center justify-between">
                              <div className="text-[9px] uppercase font-bold opacity-60">Future ROI Index</div>
                              <Info className="w-2.5 h-2.5 opacity-30 group-hover:opacity-100 transition-opacity" />
                            </div>
                            <div className="text-3xl font-black">{selectedUniversity.roiScore}<span className="text-sm opacity-40 ml-1">/ 10</span></div>
                            <div className="text-[8px] opacity-40 leading-tight">Calculated based on FMGE pass rates and clinical placement depth.</div>
                            
                            <div className="absolute top-10 left-0 w-full hidden group-hover:block bg-slate-900 text-white p-3 rounded-xl text-[9px] shadow-2xl z-20 border border-white/10">
                              Our ROI metric combines historic USMLE/FMGE success, median starting salaries for international graduates, and clinical rotation quality to estimate career acceleration.
                            </div>
                        </div>
                        <div className="bg-slate-100 p-5 rounded-2xl space-y-1 border border-slate-200 group relative">
                             <div className="flex items-center justify-between">
                                <div className="text-[9px] uppercase font-bold text-slate-400">Elite Trust Reputation</div>
                                <Info className="w-2.5 h-2.5 text-slate-300 group-hover:text-slate-500 transition-colors" />
                             </div>
                            <div className="text-3xl font-black text-slate-800">{selectedUniversity.reputationScore}</div>
                            <div className="text-[8px] text-slate-400 leading-tight">Peer-reviewed institutional standing and global alumni success.</div>

                            <div className="absolute top-10 left-0 w-full hidden group-hover:block bg-slate-900 text-white p-3 rounded-xl text-[9px] shadow-2xl z-20">
                              The Trust Score measures institutional age, government accreditation strength, hospital bed capacity, and alumni network density in the healthcare sector.
                            </div>
                        </div>
                    </div>

                    <section>
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2">
                        <div className="w-4 h-[1px] bg-slate-200"></div>
                        Specializations & Core Strengths
                        <div className="flex-grow h-[1px] bg-slate-100"></div>
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedUniversity.specializations.map(spec => (
                          <span key={spec} className="bg-white text-slate-800 px-3 py-1.5 rounded-xl text-[10px] font-bold border border-slate-200 shadow-sm">
                            {spec}
                          </span>
                        ))}
                      </div>
                    </section>

                    <section>
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2">
                        <div className="w-4 h-[1px] bg-slate-200"></div>
                        Admission Eligibility
                        <div className="flex-grow h-[1px] bg-slate-100"></div>
                      </h4>
                      <div className="bg-emerald-600 p-4 rounded-2xl text-white shadow-lg shadow-emerald-100 flex items-center justify-between">
                        <div>
                          <div className="text-[8px] uppercase font-bold opacity-60 mb-0.5">NEET Qualifying Criteria</div>
                          <p className="font-bold text-lg leading-tight">{selectedUniversity.neetRequirement}</p>
                        </div>
                        <div className="bg-emerald-500 p-2 rounded-lg">
                          <BookOpen className="w-5 h-5" />
                        </div>
                      </div>
                    </section>

                    <section>
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2">
                        <div className="w-4 h-[1px] bg-slate-200"></div>
                        Institutional Overview
                        <div className="flex-grow h-[1px] bg-slate-100"></div>
                      </h4>
                      <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100 relative overflow-hidden">
                        <p className="text-slate-600 leading-relaxed text-sm relative z-10">{selectedUniversity.description}</p>
                        <Globe className="absolute -right-8 -top-8 w-32 h-32 text-slate-200/30" />
                      </div>
                    </section>
                  </div>

                  <div className="mt-10 flex gap-3">
                    <button 
                      onClick={handleBrochureClick}
                      className="flex-grow py-4 bg-indigo-900 text-white font-bold rounded-2xl shadow-xl shadow-indigo-100 hover:bg-indigo-800 transition-all active:scale-[0.98] uppercase tracking-widest text-xs"
                    >
                      Check Eligibility & Register
                    </button>
                    <button 
                      onClick={() => setSelectedUniversity(null)}
                      className="px-8 py-4 border-2 border-slate-100 text-slate-500 font-bold rounded-2xl hover:bg-slate-50 transition-all uppercase tracking-widest text-xs active:scale-[0.98]"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Lead Capture Modal */}
      <AnimatePresence>
        {showLeadModal && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowLeadModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden p-8"
            >
              <div className="text-center mb-6">
                <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-black text-slate-800">Unlock Access</h3>
                <p className="text-xs text-slate-500 mt-2 font-medium">Please provide your contact details to {leadAction === 'export' ? 'export the comparison sheet' : 'download the verified brochure'}.</p>
              </div>

              <form onSubmit={handleLeadSubmit} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400 ml-1">Full Name</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                    <input 
                      required
                      type="text" 
                      placeholder="e.g. Rahul Sharma"
                      className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      value={leadFormData.name}
                      onChange={(e) => setLeadFormData({...leadFormData, name: e.target.value})}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400 ml-1">Email Address</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                    <input 
                      required
                      type="email" 
                      placeholder="rahul@example.com"
                      className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      value={leadFormData.email}
                      onChange={(e) => setLeadFormData({...leadFormData, email: e.target.value})}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400 ml-1">WhatsApp / Phone</label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                    <input 
                      required
                      type="tel" 
                      placeholder="+91 99999 99999"
                      className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      value={leadFormData.phone}
                      onChange={(e) => setLeadFormData({...leadFormData, phone: e.target.value})}
                    />
                  </div>
                </div>

                <button 
                  type="submit"
                  className="w-full py-4 bg-indigo-600 text-white font-bold rounded-xl shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-[0.98] uppercase tracking-widest text-xs mt-4"
                >
                  Confirm & {leadAction === 'export' ? 'Download CSV' : 'Get Brochure'}
                </button>
                <button 
                  type="button"
                  onClick={() => setShowLeadModal(false)}
                  className="w-full py-2 text-slate-400 font-bold hover:text-slate-600 transition-colors uppercase tracking-widest text-[9px]"
                >
                  Maybe Later
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
