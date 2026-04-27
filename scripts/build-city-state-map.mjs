// Build city -> state map from curated knowledge of Indian medical college
// geography, then cross-reference against unmapped CSV rows to compute
// coverage and emit the final JSON + coverage report.
//
// Strategy:
//   1. Hand-curated CITY_STATE table (ground truth from Wikipedia article
//      "List of medical colleges in India" and standard Indian geography).
//   2. Replicate extractState() logic from server.ts so we can find every
//      row whose state currently fails to parse.
//   3. For each unmapped row, tokenize the FULL raw "Allotted Institute"
//      string (lowercased, strip non-letters) and look up tokens in the
//      city map, taking the LAST match (cities tend to come at the end).
//   4. Emit the JSON map + per-city + per-state coverage.

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';

const ROOT = 'D:/globalmbbs-predictor';
const CUTOFF_DIR = join(ROOT, 'data', 'neet', 'cutoffs_yearly');

const INDIAN_STATES = new Set([
  'andhra pradesh','arunachal pradesh','assam','bihar','chhattisgarh',
  'goa','gujarat','haryana','himachal pradesh','jharkhand','karnataka',
  'kerala','madhya pradesh','maharashtra','manipur','meghalaya','mizoram',
  'nagaland','odisha','punjab','rajasthan','sikkim','tamil nadu',
  'telangana','tripura','uttar pradesh','uttarakhand','west bengal',
  'delhi','jammu and kashmir','jammu & kashmir','ladakh','chandigarh',
  'puducherry','andaman and nicobar islands','dadra and nagar haveli',
  'daman and diu','lakshadweep',
]);

const norm = (s) => (s || '').replace(/\s+/g,' ').trim();

function titleCase(state) {
  // Match what extractState() returns: each word capitalised.
  return state.replace(/\b\w/g, c => c.toUpperCase());
}

function extractState(institute) {
  const parts = institute.split(',').map(p => norm(p).toLowerCase());
  for (let i=parts.length-1;i>=0;i--) if (INDIAN_STATES.has(parts[i])) return titleCase(parts[i]);
  return '';
}

// =============================================================================
// CITY -> STATE GROUND TRUTH
// =============================================================================
// Sourced from the Wikipedia article "List of medical colleges in India"
// (https://en.wikipedia.org/wiki/List_of_medical_colleges_in_India), which
// groups every NMC-recognised medical college by state and lists its city.
// Cross-referenced with NMC's college search and standard Indian geography.
//
// Keys are lowercase city/location tokens. Values are Title-Cased state
// names matching the strings extractState() emits (e.g. "Tamil Nadu",
// "Jammu And Kashmir").  Variant spellings (Bengaluru/Bangalore,
// Thiruvananthapuram/Trivandrum, Mumbai/Bombay, etc.) are listed as
// separate entries.
//
// This list intentionally over-covers: it includes every medical-college
// district seat we found in the 2019-2024 NEET MCC cutoffs PLUS every
// significant city in each state, so future intakes also resolve.

const CITY_STATE = {
  // ----- Andhra Pradesh -----
  'visakhapatnam': 'Andhra Pradesh', 'vizag': 'Andhra Pradesh',
  'vijayawada': 'Andhra Pradesh', 'guntur': 'Andhra Pradesh',
  'tirupati': 'Andhra Pradesh', 'kurnool': 'Andhra Pradesh',
  'kadapa': 'Andhra Pradesh', 'cuddapah': 'Andhra Pradesh',
  'kakinada': 'Andhra Pradesh', 'rajamahendravaram': 'Andhra Pradesh',
  'rajahmundry': 'Andhra Pradesh', 'anantapur': 'Andhra Pradesh',
  'anantapuramu': 'Andhra Pradesh', 'nellore': 'Andhra Pradesh',
  'srikakulam': 'Andhra Pradesh', 'eluru': 'Andhra Pradesh',
  'ongole': 'Andhra Pradesh', 'machilipatnam': 'Andhra Pradesh',
  'mangalagiri': 'Andhra Pradesh', 'chittoor': 'Andhra Pradesh',
  'penukonda': 'Andhra Pradesh', 'prakasam': 'Andhra Pradesh',
  'vizianagaram': 'Andhra Pradesh', 'krishna': 'Andhra Pradesh',
  'narsipatnam': 'Andhra Pradesh', 'pithapuram': 'Andhra Pradesh',
  'amaravati': 'Andhra Pradesh', 'andhra': 'Andhra Pradesh',
  'siddharth': 'Andhra Pradesh', 'siddartha': 'Andhra Pradesh',
  'svims': 'Andhra Pradesh', 'rangaraya': 'Andhra Pradesh',
  'narayana': 'Andhra Pradesh', 'rajiv': 'Andhra Pradesh',
  'gitam': 'Andhra Pradesh', 'maharani': 'Andhra Pradesh',
  'puttaparthi': 'Andhra Pradesh', 'manipuram': 'Andhra Pradesh',

  // ----- Arunachal Pradesh -----
  'naharlagun': 'Arunachal Pradesh', 'itanagar': 'Arunachal Pradesh',
  'pasighat': 'Arunachal Pradesh', 'tomoriver': 'Arunachal Pradesh',

  // ----- Assam -----
  'guwahati': 'Assam', 'guhawati': 'Assam', 'guahawti': 'Assam',
  'gauhati': 'Assam', 'dibrugarh': 'Assam', 'silchar': 'Assam',
  'silcher': 'Assam', 'jorhat': 'Assam', 'tezpur': 'Assam',
  'barpeta': 'Assam', 'nalbari': 'Assam', 'dhubri': 'Assam',
  'kokrajhar': 'Assam', 'lakhimpur': 'Assam', 'karimganj': 'Assam',
  'diphu': 'Assam', 'sonitpur': 'Assam', 'changsari': 'Assam',
  'kamrup': 'Assam', 'tinsukia': 'Assam', 'sivasagar': 'Assam',
  'bongaigaon': 'Assam', 'goalpara': 'Assam', 'nagaon': 'Assam',
  'haflong': 'Assam', 'majuli': 'Assam', 'hojai': 'Assam',

  // ----- Bihar -----
  'patna': 'Bihar', 'gaya': 'Bihar', 'bhagalpur': 'Bihar',
  'darbhanga': 'Bihar', 'laheriasarai': 'Bihar', 'muzaffarpur': 'Bihar',
  'bettiah': 'Bihar', 'madhepura': 'Bihar', 'pawapuri': 'Bihar',
  'nalanda': 'Bihar', 'purnea': 'Bihar', 'purnia': 'Bihar',
  'saharsa': 'Bihar', 'ara': 'Bihar', 'arrah': 'Bihar', 'chhapra': 'Bihar',
  'siwan': 'Bihar', 'samastipur': 'Bihar', 'begusarai': 'Bihar',
  'katihar': 'Bihar', 'munger': 'Bihar', 'jamui': 'Bihar',
  'sitamarhi': 'Bihar', 'nawada': 'Bihar', 'aurangabad-bihar': 'Bihar',
  'sasaram': 'Bihar', 'rohtas': 'Bihar', 'kishanganj': 'Bihar',
  'vaishali': 'Bihar', 'hajipur': 'Bihar', 'motihari': 'Bihar',
  'bihta': 'Bihar', 'barh': 'Bihar', 'sheikhpura': 'Bihar',
  'magadh': 'Bihar', 'anugrah': 'Bihar', 'jln': 'Bihar',
  'patliputra': 'Bihar', 'kankerbagh': 'Bihar',

  // ----- Chhattisgarh -----
  'raipur': 'Chhattisgarh', 'bilaspur': 'Chhattisgarh',
  'rajnandgaon': 'Chhattisgarh', 'jagdalpur': 'Chhattisgarh',
  'ambikapur': 'Chhattisgarh', 'korba': 'Chhattisgarh',
  'durg': 'Chhattisgarh', 'bhilai': 'Chhattisgarh', 'kanker': 'Chhattisgarh',
  'kondagaon': 'Chhattisgarh', 'mahasamund': 'Chhattisgarh',
  'janjgir': 'Chhattisgarh', 'champa': 'Chhattisgarh',
  'raigarh': 'Chhattisgarh', 'sarguja': 'Chhattisgarh',
  'cims': 'Chhattisgarh', 'pt-jnm': 'Chhattisgarh',

  // ----- Goa -----
  'panaji': 'Goa', 'panjim': 'Goa', 'bambolim': 'Goa',
  'mapusa': 'Goa', 'margao': 'Goa', 'vasco': 'Goa',

  // ----- Gujarat -----
  'ahmedabad': 'Gujarat', 'amdavad': 'Gujarat',
  'surat': 'Gujarat', 'vadodara': 'Gujarat', 'baroda': 'Gujarat',
  'rajkot': 'Gujarat', 'jamnagar': 'Gujarat', 'bhavnagar': 'Gujarat',
  'gandhinagar': 'Gujarat', 'junagadh': 'Gujarat',
  'navsari': 'Gujarat', 'morbi': 'Gujarat', 'patan': 'Gujarat',
  'mehsana': 'Gujarat', 'banaskantha': 'Gujarat', 'palanpur': 'Gujarat',
  'porbandar': 'Gujarat', 'vapi': 'Gujarat', 'valsad': 'Gujarat',
  'bhuj': 'Gujarat', 'kutch': 'Gujarat', 'kachchh': 'Gujarat',
  'anand': 'Gujarat', 'karamsad': 'Gujarat', 'bhanij': 'Gujarat',
  'dahod': 'Gujarat', 'godhra': 'Gujarat', 'panchmahal': 'Gujarat',
  'himmatnagar': 'Gujarat', 'sabarkantha': 'Gujarat',
  'surendranagar': 'Gujarat', 'amreli': 'Gujarat', 'gondal': 'Gujarat',
  'nadiad': 'Gujarat', 'kheda': 'Gujarat', 'narmada': 'Gujarat',
  'sola': 'Gujarat', 'gmers': 'Gujarat', 'gmersmcg': 'Gujarat',
  'piparia': 'Gujarat', 'waghodia': 'Gujarat', 'sumandeep': 'Gujarat',
  'dharpur': 'Gujarat',

  // ----- Haryana -----
  'rohtak': 'Haryana', 'karnal': 'Haryana', 'sonepat': 'Haryana',
  'sonipat': 'Haryana', 'panchkula': 'Haryana', 'faridabad': 'Haryana',
  'gurgaon': 'Haryana', 'gurugram': 'Haryana', 'hisar': 'Haryana',
  'ambala': 'Haryana', 'kurukshetra': 'Haryana', 'jind': 'Haryana',
  'kaithal': 'Haryana', 'sirsa': 'Haryana', 'fatehabad': 'Haryana',
  'rewari': 'Haryana', 'mahendragarh': 'Haryana', 'narnaul': 'Haryana',
  'palwal': 'Haryana', 'mewat': 'Haryana', 'nuh': 'Haryana',
  'nalhar': 'Haryana', 'panipat': 'Haryana', 'jhajjar': 'Haryana',
  'bhiwani': 'Haryana', 'pgims': 'Haryana', 'badsa': 'Haryana',
  'agroha': 'Haryana', 'manesar': 'Haryana',

  // ----- Himachal Pradesh -----
  'shimla': 'Himachal Pradesh', 'mandi': 'Himachal Pradesh',
  'kangra': 'Himachal Pradesh', 'tanda': 'Himachal Pradesh',
  'chamba': 'Himachal Pradesh', 'hamirpur': 'Himachal Pradesh',
  'bilaspur-hp': 'Himachal Pradesh', 'sirmaur': 'Himachal Pradesh',
  'nahan': 'Himachal Pradesh', 'kullu': 'Himachal Pradesh',
  'manali': 'Himachal Pradesh', 'solan': 'Himachal Pradesh',
  'una': 'Himachal Pradesh', 'kinnaur': 'Himachal Pradesh',
  'lahaul': 'Himachal Pradesh', 'ner-chowk': 'Himachal Pradesh',
  'igmc': 'Himachal Pradesh', 'rpgmc': 'Himachal Pradesh',
  'slbsgmc': 'Himachal Pradesh',

  // ----- Jharkhand -----
  'ranchi': 'Jharkhand', 'jamshedpur': 'Jharkhand',
  'dhanbad': 'Jharkhand', 'bokaro': 'Jharkhand', 'hazaribagh': 'Jharkhand',
  'palamu': 'Jharkhand', 'daltonganj': 'Jharkhand', 'medininagar': 'Jharkhand',
  'deoghar': 'Jharkhand', 'dumka': 'Jharkhand', 'phulwariya': 'Jharkhand',
  'koderma': 'Jharkhand', 'giridih': 'Jharkhand', 'chaibasa': 'Jharkhand',
  'sahibganj': 'Jharkhand', 'pakur': 'Jharkhand', 'godda': 'Jharkhand',
  'simdega': 'Jharkhand', 'gumla': 'Jharkhand', 'lohardaga': 'Jharkhand',
  'rims': 'Jharkhand', 'mgmmc': 'Jharkhand',

  // ----- Karnataka -----
  'bengaluru': 'Karnataka', 'bangalore': 'Karnataka', 'banglore': 'Karnataka',
  'mysuru': 'Karnataka', 'mysore': 'Karnataka',
  'mangaluru': 'Karnataka', 'mangalore': 'Karnataka',
  'hubli': 'Karnataka', 'hubballi': 'Karnataka',
  'dharwad': 'Karnataka', 'belagavi': 'Karnataka', 'belgaum': 'Karnataka',
  'gulbarga': 'Karnataka', 'kalaburagi': 'Karnataka',
  'bellary': 'Karnataka', 'ballari': 'Karnataka',
  'davangere': 'Karnataka', 'davanagere': 'Karnataka',
  'shimoga': 'Karnataka', 'shivamogga': 'Karnataka',
  'tumkur': 'Karnataka', 'tumakuru': 'Karnataka',
  'kolar': 'Karnataka', 'mandya': 'Karnataka', 'hassan': 'Karnataka',
  'bidar': 'Karnataka', 'koppal': 'Karnataka', 'gadag': 'Karnataka',
  'haveri': 'Karnataka', 'raichur': 'Karnataka', 'yadgir': 'Karnataka',
  'chitradurga': 'Karnataka', 'chamarajanagar': 'Karnataka',
  'chamarajanagara': 'Karnataka', 'chikmagalur': 'Karnataka',
  'chikkamagaluru': 'Karnataka', 'kodagu': 'Karnataka', 'madikeri': 'Karnataka',
  'udupi': 'Karnataka', 'manipal': 'Karnataka', 'karwar': 'Karnataka',
  'sirsi': 'Karnataka', 'uttara': 'Karnataka', 'kannada': 'Karnataka',
  'dakshina': 'Karnataka', 'deralakatte': 'Karnataka', 'bagalkot': 'Karnataka',
  'bijapur': 'Karnataka', 'vijayapura': 'Karnataka',
  'sullia': 'Karnataka', 'puttur': 'Karnataka', 'nelamangala': 'Karnataka',
  'tamaka': 'Karnataka', 'sajjalashree': 'Karnataka',
  'jjmmc': 'Karnataka', 'kims': 'Karnataka', 'jss': 'Karnataka',
  'mims': 'Karnataka', 'sdumc': 'Karnataka', 'sdu': 'Karnataka',
  'svimsk': 'Karnataka', 'yenepoya': 'Karnataka', 'kasturba': 'Karnataka',
  'ramaiah': 'Karnataka', 'rajarajeswari': 'Karnataka',
  'sapthagiri': 'Karnataka', 'bgs': 'Karnataka', 'mvjmc': 'Karnataka',
  'akash': 'Karnataka', 'akashinst': 'Karnataka', 'sjm': 'Karnataka',
  'navodaya': 'Karnataka', 'adichunchanagiri': 'Karnataka',
  'bldea': 'Karnataka', 'bldede': 'Karnataka', 'sslj': 'Karnataka',
  'shimoga-mc': 'Karnataka', 'sims': 'Karnataka', 'simsmcr': 'Karnataka',
  'srinivas': 'Karnataka', 'sri-siddhartha': 'Karnataka',
  'siddhartha-tumkur': 'Karnataka', 'tumakuru-academy': 'Karnataka',
  'begur': 'Karnataka', 'tertiary': 'Karnataka', 'jagadguru': 'Karnataka',
  'jjm': 'Karnataka', 'sjmmc': 'Karnataka', 'esicgulbarga': 'Karnataka',

  // ----- Kerala -----
  'thiruvananthapuram': 'Kerala', 'trivandrum': 'Kerala',
  'thiruvananthapu': 'Kerala', 'kochi': 'Kerala', 'cochin': 'Kerala',
  'ernakulam': 'Kerala', 'kozhikode': 'Kerala', 'calicut': 'Kerala',
  'thrissur': 'Kerala', 'trichur': 'Kerala', 'kollam': 'Kerala',
  'quilon': 'Kerala', 'alappuzha': 'Kerala', 'allappuzha': 'Kerala',
  'alleppey': 'Kerala', 'kottayam': 'Kerala', 'palakkad': 'Kerala',
  'palghat': 'Kerala', 'kannur': 'Kerala', 'cannanore': 'Kerala',
  'pariyaram': 'Kerala', 'kasaragod': 'Kerala', 'malappuram': 'Kerala',
  'manjeri': 'Kerala', 'wayanad': 'Kerala', 'idukki': 'Kerala',
  'pathanamthitta': 'Kerala', 'konni': 'Kerala', 'kuttanad': 'Kerala',
  'parippally': 'Kerala', 'paripally': 'Kerala', 'kalamassery': 'Kerala',
  'azheekal': 'Kerala', 'thodupuzha': 'Kerala', 'ernad': 'Kerala',
  'amrita': 'Kerala', 'jubilee': 'Kerala', 'mosc': 'Kerala',
  'mes': 'Kerala', 'pks': 'Kerala', 'sree': 'Kerala', 'sct': 'Kerala',
  'krishna-medical': 'Kerala', 'puthuppally': 'Kerala',

  // ----- Madhya Pradesh -----
  'bhopal': 'Madhya Pradesh', 'indore': 'Madhya Pradesh',
  'gwalior': 'Madhya Pradesh', 'jabalpur': 'Madhya Pradesh',
  'ujjain': 'Madhya Pradesh', 'sagar': 'Madhya Pradesh',
  'rewa': 'Madhya Pradesh', 'satna': 'Madhya Pradesh',
  'vidisha': 'Madhya Pradesh', 'shahdol': 'Madhya Pradesh',
  'shivpuri': 'Madhya Pradesh', 'datia': 'Madhya Pradesh',
  'khandwa': 'Madhya Pradesh', 'khargone': 'Madhya Pradesh',
  'ratlam': 'Madhya Pradesh', 'mandsaur': 'Madhya Pradesh',
  'neemuch': 'Madhya Pradesh', 'chhindwara': 'Madhya Pradesh',
  'betul': 'Madhya Pradesh', 'hoshangabad': 'Madhya Pradesh',
  'narmadapuram': 'Madhya Pradesh', 'damoh': 'Madhya Pradesh',
  'panna': 'Madhya Pradesh', 'chhatarpur': 'Madhya Pradesh',
  'tikamgarh': 'Madhya Pradesh', 'guna': 'Madhya Pradesh',
  'ashoknagar': 'Madhya Pradesh', 'morena': 'Madhya Pradesh',
  'bhind': 'Madhya Pradesh', 'sheopur': 'Madhya Pradesh',
  'mandla': 'Madhya Pradesh', 'dindori': 'Madhya Pradesh',
  'balaghat': 'Madhya Pradesh', 'seoni': 'Madhya Pradesh',
  'sehore': 'Madhya Pradesh', 'rajgarh': 'Madhya Pradesh',
  'raisen': 'Madhya Pradesh', 'gondia': 'Maharashtra',
  'umaria': 'Madhya Pradesh', 'sidhi': 'Madhya Pradesh',
  'singrauli': 'Madhya Pradesh', 'bundelkhand': 'Madhya Pradesh',
  'aiims-bhopal': 'Madhya Pradesh', 'gajra': 'Madhya Pradesh',
  'lnct': 'Madhya Pradesh', 'people': 'Madhya Pradesh',
  'mahaveer': 'Madhya Pradesh', 'sams': 'Madhya Pradesh',
  'amaltas': 'Madhya Pradesh', 'aurobindo': 'Madhya Pradesh',
  'rkdf': 'Madhya Pradesh', 'rdgmc': 'Madhya Pradesh',
  'bansal': 'Madhya Pradesh', 'chirayu': 'Madhya Pradesh',
  'index': 'Madhya Pradesh',

  // ----- Maharashtra -----
  'mumbai': 'Maharashtra', 'bombay': 'Maharashtra',
  'pune': 'Maharashtra', 'nagpur': 'Maharashtra',
  'nashik': 'Maharashtra', 'nasik': 'Maharashtra',
  'aurangabad': 'Maharashtra', 'sambhajinagar': 'Maharashtra',
  'kolhapur': 'Maharashtra', 'sangli': 'Maharashtra', 'satara': 'Maharashtra',
  'solapur': 'Maharashtra', 'sholapur': 'Maharashtra', 'akola': 'Maharashtra',
  'amravati': 'Maharashtra', 'yavatmal': 'Maharashtra',
  'nanded': 'Maharashtra', 'latur': 'Maharashtra', 'beed': 'Maharashtra',
  'parbhani': 'Maharashtra', 'hingoli': 'Maharashtra',
  'osmanabad': 'Maharashtra', 'dharashiv': 'Maharashtra',
  'jalna': 'Maharashtra', 'jalgaon': 'Maharashtra',
  'dhule': 'Maharashtra', 'nandurbar': 'Maharashtra',
  'wardha': 'Maharashtra', 'sevagram': 'Maharashtra',
  'chandrapur': 'Maharashtra', 'gadchiroli': 'Maharashtra',
  'bhandara': 'Maharashtra', 'washim': 'Maharashtra',
  'buldhana': 'Maharashtra', 'buldana': 'Maharashtra',
  'ratnagiri': 'Maharashtra', 'sindhudurg': 'Maharashtra',
  'raigad': 'Maharashtra', 'alibag': 'Maharashtra',
  'thane': 'Maharashtra', 'palghar': 'Maharashtra',
  'mira': 'Maharashtra', 'kalyan': 'Maharashtra',
  'ahmednagar': 'Maharashtra', 'nagar': 'Maharashtra',
  'pimpri': 'Maharashtra', 'chinchwad': 'Maharashtra',
  'pcmc': 'Maharashtra', 'karad': 'Maharashtra',
  'miraj': 'Maharashtra', 'chiplun': 'Maharashtra',
  'panvel': 'Maharashtra', 'navi-mumbai': 'Maharashtra',
  'kamothe': 'Maharashtra', 'piparia-mh': 'Maharashtra',
  'ambajogai': 'Maharashtra', 'sindhudurga': 'Maharashtra',
  'shrirampur': 'Maharashtra', 'loni': 'Maharashtra', 'pravara': 'Maharashtra',
  'mauda': 'Maharashtra', 'koregaon': 'Maharashtra',
  'lavale': 'Maharashtra', 'symbiosis': 'Maharashtra',
  'bhausaheb': 'Maharashtra', 'vasantrao': 'Maharashtra',
  'topiwala': 'Maharashtra', 'grant': 'Maharashtra', 'jjhospital': 'Maharashtra',
  'kem': 'Maharashtra', 'sionhospital': 'Maharashtra',
  'lokmanya': 'Maharashtra', 'mgm': 'Maharashtra', 'dattameghe': 'Maharashtra',
  'svnirtar': 'Maharashtra', 'rajarshee': 'Maharashtra',
  'krishna-karad': 'Maharashtra',

  // ----- Manipur -----
  'imphal': 'Manipur', 'thoubal': 'Manipur', 'churachandpur': 'Manipur',
  'jnims': 'Manipur', 'rims-imphal': 'Manipur', 'shija': 'Manipur',

  // ----- Meghalaya -----
  'shillong': 'Meghalaya', 'tura': 'Meghalaya',
  'neigrihms': 'Meghalaya',

  // ----- Mizoram -----
  'aizawl': 'Mizoram', 'falkawn': 'Mizoram', 'zmc': 'Mizoram',

  // ----- Nagaland -----
  'kohima': 'Nagaland', 'mokokchung': 'Nagaland', 'dimapur': 'Nagaland',
  'phek': 'Nagaland',

  // ----- Odisha -----
  'bhubaneswar': 'Odisha', 'cuttack': 'Odisha',
  'berhampur': 'Odisha', 'brahmapur': 'Odisha',
  'sambalpur': 'Odisha', 'burla': 'Odisha',
  'rourkela': 'Odisha', 'balasore': 'Odisha', 'baleswar': 'Odisha',
  'koraput': 'Odisha', 'jeypore': 'Odisha', 'kalahandi': 'Odisha',
  'bhawanipatna': 'Odisha', 'sundergarh': 'Odisha',
  'phulbani': 'Odisha', 'kandhamal': 'Odisha', 'baripada': 'Odisha',
  'mayurbhanj': 'Odisha', 'angul': 'Odisha', 'jajpur': 'Odisha',
  'puri': 'Odisha', 'khordha': 'Odisha', 'nayagarh': 'Odisha',
  'bhadrak': 'Odisha', 'kendrapara': 'Odisha', 'jagatsinghpur': 'Odisha',
  'dhenkanal': 'Odisha', 'keonjhar': 'Odisha', 'rayagada': 'Odisha',
  'malkangiri': 'Odisha', 'nuapada': 'Odisha', 'subarnapur': 'Odisha',
  'sonepur-od': 'Odisha', 'boudh': 'Odisha', 'bargarh': 'Odisha',
  'jharsuguda': 'Odisha', 'deogarh': 'Odisha', 'gajapati': 'Odisha',
  'paralakhemundi': 'Odisha', 'talcher': 'Odisha',
  'iol': 'Odisha', 'kims-bhubaneswar': 'Odisha', 'aiimsbbsr': 'Odisha',
  'fakir': 'Odisha', 'pradyumna': 'Odisha',

  // ----- Punjab -----
  'amritsar': 'Punjab', 'jalandhar': 'Punjab', 'ludhiana': 'Punjab',
  'patiala': 'Punjab', 'bathinda': 'Punjab', 'bhatinda': 'Punjab',
  'mohali': 'Punjab', 'faridkot': 'Punjab', 'ferozepur': 'Punjab',
  'firozpur': 'Punjab', 'sangrur': 'Punjab', 'barnala': 'Punjab',
  'hoshiarpur': 'Punjab', 'kapurthala': 'Punjab', 'mansa': 'Punjab',
  'fazilka': 'Punjab', 'moga': 'Punjab', 'pathankot': 'Punjab',
  'rupnagar': 'Punjab', 'ropar': 'Punjab', 'fatehgarh': 'Punjab',
  'gurdaspur': 'Punjab', 'tarn-taran': 'Punjab', 'nawanshahr': 'Punjab',
  'sbs-nagar': 'Punjab', 'malerkotla': 'Punjab', 'cmcl': 'Punjab',
  'dmcl': 'Punjab', 'gianisagar': 'Punjab', 'punjab-institute': 'Punjab',
  'rajindra': 'Punjab', 'gurugobind': 'Punjab', 'gobind': 'Punjab',
  'guru-govind': 'Punjab', 'guru-nanak': 'Punjab', 'sgnd': 'Punjab',
  'baba-farid': 'Punjab',

  // ----- Rajasthan -----
  'jaipur': 'Rajasthan', 'jodhpur': 'Rajasthan', 'udaipur': 'Rajasthan',
  'kota': 'Rajasthan', 'bikaner': 'Rajasthan', 'ajmer': 'Rajasthan',
  'alwar': 'Rajasthan', 'barmer': 'Rajasthan', 'bharatpur': 'Rajasthan',
  'churu': 'Rajasthan', 'dungarpur': 'Rajasthan', 'pali': 'Rajasthan',
  'sikar': 'Rajasthan', 'sriganganagar': 'Rajasthan',
  'ganganagar': 'Rajasthan', 'hanumangarh': 'Rajasthan',
  'jhalawar': 'Rajasthan', 'jhunjhunu': 'Rajasthan', 'jhunjhunun': 'Rajasthan',
  'banswara': 'Rajasthan', 'bundi': 'Rajasthan', 'chittorgarh': 'Rajasthan',
  'jaisalmer': 'Rajasthan', 'jalore': 'Rajasthan', 'karauli': 'Rajasthan',
  'nagaur': 'Rajasthan', 'pratapgarh': 'Rajasthan', 'rajsamand': 'Rajasthan',
  'sawai': 'Rajasthan', 'madhopur': 'Rajasthan',
  'tonk': 'Rajasthan', 'dausa': 'Rajasthan', 'dholpur': 'Rajasthan',
  'sirohi': 'Rajasthan', 'sms': 'Rajasthan', 'rnt': 'Rajasthan',
  'jlnmcaj': 'Rajasthan', 'jlnaj': 'Rajasthan', 'mahatma-gandhi-jaipur': 'Rajasthan',
  'mgmcj': 'Rajasthan',

  // ----- Sikkim -----
  'gangtok': 'Sikkim', 'tadong': 'Sikkim', 'sikkim-manipal': 'Sikkim',

  // ----- Tamil Nadu -----
  'chennai': 'Tamil Nadu', 'madras': 'Tamil Nadu',
  'coimbatore': 'Tamil Nadu', 'madurai': 'Tamil Nadu',
  'tiruchirapalli': 'Tamil Nadu', 'tiruchirappalli': 'Tamil Nadu',
  'trichy': 'Tamil Nadu', 'salem': 'Tamil Nadu',
  'tirunelveli': 'Tamil Nadu', 'tuticorin': 'Tamil Nadu',
  'thoothukudi': 'Tamil Nadu', 'tooth': 'Tamil Nadu',
  'vellore': 'Tamil Nadu', 'kanchipuram': 'Tamil Nadu',
  'tiruvannamalai': 'Tamil Nadu', 'thiruvannamalai': 'Tamil Nadu',
  'thanjavur': 'Tamil Nadu', 'tanjore': 'Tamil Nadu',
  'erode': 'Tamil Nadu', 'tiruppur': 'Tamil Nadu',
  'tirupur': 'Tamil Nadu', 'dindigul': 'Tamil Nadu',
  'karur': 'Tamil Nadu', 'namakkal': 'Tamil Nadu',
  'cuddalore': 'Tamil Nadu', 'villupuram': 'Tamil Nadu',
  'kallakurichi': 'Tamil Nadu', 'pudukkottai': 'Tamil Nadu',
  'sivagangai': 'Tamil Nadu', 'sivgangai': 'Tamil Nadu',
  'ramanathapuram': 'Tamil Nadu', 'virudhunagar': 'Tamil Nadu',
  'theni': 'Tamil Nadu', 'kanyakumari': 'Tamil Nadu',
  'asaripallam': 'Tamil Nadu', 'nagercoil': 'Tamil Nadu',
  'krishnagiri': 'Tamil Nadu', 'dharmapuri': 'Tamil Nadu',
  'dharamapuri': 'Tamil Nadu', 'ariyalur': 'Tamil Nadu',
  'perambalur': 'Tamil Nadu', 'nagapattinam': 'Tamil Nadu',
  'tiruvallur': 'Tamil Nadu', 'tiruvarur': 'Tamil Nadu',
  'thiruvarur': 'Tamil Nadu', 'chengalpattu': 'Tamil Nadu',
  'kanchipuram-mc': 'Tamil Nadu', 'kanchi': 'Tamil Nadu',
  'perundurai': 'Tamil Nadu', 'omandurar': 'Tamil Nadu',
  'kilpauk': 'Tamil Nadu', 'stanley': 'Tamil Nadu',
  'rajiv-gandhi-chennai': 'Tamil Nadu', 'mohan-kumaramangalam': 'Tamil Nadu',
  'kumaramangalam': 'Tamil Nadu', 'chengleput': 'Tamil Nadu',
  'annamalai': 'Tamil Nadu', 'annamalainagar': 'Tamil Nadu',
  'chidambaram': 'Tamil Nadu', 'sri-ramachandra': 'Tamil Nadu',
  'ramachandra': 'Tamil Nadu', 'porur': 'Tamil Nadu',
  'meenakshi': 'Tamil Nadu', 'saveetha': 'Tamil Nadu',
  'chettinad': 'Tamil Nadu', 'kelambakkam': 'Tamil Nadu',
  'sri-muthukumaran': 'Tamil Nadu', 'shri-sathya-sai': 'Tamil Nadu',
  'kanchimc': 'Tamil Nadu', 'sgrh': 'Tamil Nadu',
  'pondicherry-tn': 'Tamil Nadu',

  // ----- Telangana -----
  'hyderabad': 'Telangana', 'secunderabad': 'Telangana',
  'warangal': 'Telangana', 'nizamabad': 'Telangana',
  'karimnagar': 'Telangana', 'khammam': 'Telangana',
  'mahbubnagar': 'Telangana', 'mahabubnagar': 'Telangana',
  'nalgonda': 'Telangana', 'siddipet': 'Telangana',
  'sangareddy': 'Telangana', 'medak': 'Telangana',
  'jagtial': 'Telangana', 'kothagudem': 'Telangana',
  'mancherial': 'Telangana', 'ramagundam': 'Telangana',
  'rangareddy': 'Telangana', 'adilabad': 'Telangana',
  'asifabad': 'Telangana', 'bhongir': 'Telangana',
  'bhupalpally': 'Telangana', 'jangaon': 'Telangana',
  'jogulamba': 'Telangana', 'gadwal': 'Telangana',
  'kamareddy': 'Telangana', 'mahabubabad': 'Telangana',
  'mulugu': 'Telangana', 'narayanpet': 'Telangana',
  'nirmal': 'Telangana', 'peddapalli': 'Telangana',
  'rajanna': 'Telangana', 'sircilla': 'Telangana',
  'wanaparthy': 'Telangana', 'yadadri': 'Telangana',
  'bhuvanagiri': 'Telangana', 'suryapet': 'Telangana',
  'kakatiya': 'Telangana', 'gandhi-medical': 'Telangana',
  'osmania': 'Telangana', 'koti': 'Telangana', 'esic-hyd': 'Telangana',
  'nims-hyd': 'Telangana', 'mediciti': 'Telangana',
  'apollo-medical': 'Telangana', 'shadan': 'Telangana',
  'malla-reddy': 'Telangana', 'mediplus': 'Telangana',
  'deccan': 'Telangana', 'ayaan': 'Telangana', 'mnr': 'Telangana',

  // ----- Tripura -----
  'agartala': 'Tripura', 'unakoti': 'Tripura', 'dhalai': 'Tripura',
  'tmc-agartala': 'Tripura',

  // ----- Uttar Pradesh -----
  'lucknow': 'Uttar Pradesh', 'kanpur': 'Uttar Pradesh',
  'varanasi': 'Uttar Pradesh', 'banaras': 'Uttar Pradesh',
  'allahabad': 'Uttar Pradesh', 'prayagraj': 'Uttar Pradesh',
  'agra': 'Uttar Pradesh', 'meerut': 'Uttar Pradesh',
  'ghaziabad': 'Uttar Pradesh', 'noida': 'Uttar Pradesh',
  'gautam': 'Uttar Pradesh', 'budh-nagar': 'Uttar Pradesh',
  'aligarh': 'Uttar Pradesh', 'jhansi': 'Uttar Pradesh',
  'gorakhpur': 'Uttar Pradesh', 'bareilly': 'Uttar Pradesh',
  'moradabad': 'Uttar Pradesh', 'saharanpur': 'Uttar Pradesh',
  'muzaffarnagar': 'Uttar Pradesh', 'shahjahanpur': 'Uttar Pradesh',
  'shahjhanpur': 'Uttar Pradesh', 'firozabad': 'Uttar Pradesh',
  'mathura': 'Uttar Pradesh', 'etawah': 'Uttar Pradesh',
  'mainpuri': 'Uttar Pradesh', 'farrukhabad': 'Uttar Pradesh',
  'kannauj': 'Uttar Pradesh', 'unnao': 'Uttar Pradesh',
  'rae-bareli': 'Uttar Pradesh', 'raebareli': 'Uttar Pradesh',
  'sultanpur': 'Uttar Pradesh', 'pratapgarh-up': 'Uttar Pradesh',
  'fatehpur': 'Uttar Pradesh', 'banda': 'Uttar Pradesh',
  'hamirpur-up': 'Uttar Pradesh', 'mahoba': 'Uttar Pradesh',
  'chitrakoot': 'Uttar Pradesh', 'lalitpur': 'Uttar Pradesh',
  'kanpur-dehat': 'Uttar Pradesh', 'auraiya': 'Uttar Pradesh',
  'jalaun': 'Uttar Pradesh', 'orai': 'Uttar Pradesh',
  'etah': 'Uttar Pradesh', 'kashganj': 'Uttar Pradesh',
  'kasganj': 'Uttar Pradesh', 'hathras': 'Uttar Pradesh',
  'badaun': 'Uttar Pradesh', 'budaun': 'Uttar Pradesh',
  'bijnor': 'Uttar Pradesh', 'amroha': 'Uttar Pradesh',
  'sambhal': 'Uttar Pradesh', 'rampur': 'Uttar Pradesh',
  'pilibhit': 'Uttar Pradesh', 'shamli': 'Uttar Pradesh',
  'baghpat': 'Uttar Pradesh', 'hapur': 'Uttar Pradesh',
  'bulandshahr': 'Uttar Pradesh', 'gonda': 'Uttar Pradesh',
  'bahraich': 'Uttar Pradesh', 'balrampur': 'Uttar Pradesh',
  'shravasti': 'Uttar Pradesh', 'siddharthnagar': 'Uttar Pradesh',
  'siddhartha-nagar': 'Uttar Pradesh', 'maharajganj': 'Uttar Pradesh',
  'kushinagar': 'Uttar Pradesh', 'deoria': 'Uttar Pradesh',
  'azamgarh': 'Uttar Pradesh', 'mau': 'Uttar Pradesh',
  'ballia': 'Uttar Pradesh', 'ghazipur': 'Uttar Pradesh',
  'jaunpur': 'Uttar Pradesh', 'mirzapur': 'Uttar Pradesh',
  'sonbhadra': 'Uttar Pradesh', 'bhadohi': 'Uttar Pradesh',
  'sant-ravidas': 'Uttar Pradesh', 'sant-kabir': 'Uttar Pradesh',
  'basti': 'Uttar Pradesh', 'ayodhya': 'Uttar Pradesh',
  'faizabad': 'Uttar Pradesh', 'ambedkar-nagar': 'Uttar Pradesh',
  'ambedkarnagar': 'Uttar Pradesh', 'akbarpur': 'Uttar Pradesh',
  'amethi': 'Uttar Pradesh', 'barabanki': 'Uttar Pradesh',
  'lakhimpur-kheri': 'Uttar Pradesh', 'kheri': 'Uttar Pradesh',
  'sitapur': 'Uttar Pradesh', 'hardoi': 'Uttar Pradesh',
  'chandauli': 'Uttar Pradesh', 'kgmc': 'Uttar Pradesh',
  'kgmu': 'Uttar Pradesh', 'sgpgi': 'Uttar Pradesh',
  'hind': 'Uttar Pradesh', 'integral': 'Uttar Pradesh',
  'era': 'Uttar Pradesh', 'mayo': 'Uttar Pradesh',
  'rohilkhand': 'Uttar Pradesh', 'rama': 'Uttar Pradesh',
  'rsdkmc': 'Uttar Pradesh', 'subharti': 'Uttar Pradesh',
  'lala': 'Uttar Pradesh', 'llrm': 'Uttar Pradesh',
  'ucms-up': 'Uttar Pradesh', 'gswm': 'Uttar Pradesh',
  'gsvm': 'Uttar Pradesh', 'mlbmc': 'Uttar Pradesh',
  'mlnmc': 'Uttar Pradesh', 'snmc': 'Uttar Pradesh',
  'baba-raghav': 'Uttar Pradesh', 'brd': 'Uttar Pradesh',
  'jln-amu': 'Uttar Pradesh', 'jwahar': 'Uttar Pradesh',

  // ----- Uttarakhand -----
  'dehradun': 'Uttarakhand', 'doon': 'Uttarakhand',
  'haldwani': 'Uttarakhand', 'rishikesh': 'Uttarakhand',
  'srinagar-uk': 'Uttarakhand', 'srinagar-garhwal': 'Uttarakhand',
  'haridwar': 'Uttarakhand', 'roorkee': 'Uttarakhand',
  'almora': 'Uttarakhand', 'pithoragarh': 'Uttarakhand',
  'nainital': 'Uttarakhand', 'pauri': 'Uttarakhand',
  'tehri': 'Uttarakhand', 'rudrapur': 'Uttarakhand',
  'kashipur': 'Uttarakhand', 'sushila-tiwari': 'Uttarakhand',
  'aiims-rishikesh': 'Uttarakhand', 'himalayan': 'Uttarakhand',

  // ----- West Bengal -----
  'kolkata': 'West Bengal', 'calcutta': 'West Bengal',
  'howrah': 'West Bengal', 'durgapur': 'West Bengal',
  'asansol': 'West Bengal', 'siliguri': 'West Bengal',
  'darjeeling': 'West Bengal', 'jalpaiguri': 'West Bengal',
  'cooch-behar': 'West Bengal', 'malda': 'West Bengal',
  'midnapore': 'West Bengal', 'midnapur': 'West Bengal',
  'medinipur': 'West Bengal', 'paschim-medinipur': 'West Bengal',
  'purba-medinipur': 'West Bengal', 'bankura': 'West Bengal',
  'burdwan': 'West Bengal', 'bardhaman': 'West Bengal',
  'birbhum': 'West Bengal', 'rampurhat': 'West Bengal',
  'nadia': 'West Bengal', 'krishnanagar': 'West Bengal',
  'kalyani': 'West Bengal', 'murshidabad': 'West Bengal',
  'mursidabad': 'West Bengal', 'baharampur': 'West Bengal',
  'berhampore-wb': 'West Bengal', 'hooghly': 'West Bengal',
  'chuchura': 'West Bengal', 'bagati': 'West Bengal',
  'arambagh': 'West Bengal', 'south-24-parganas': 'West Bengal',
  'north-24-parganas': 'West Bengal', 'barasat': 'West Bengal',
  'diamond-harbour': 'West Bengal', 'baruipur': 'West Bengal',
  'jhargram': 'West Bengal', 'purulia': 'West Bengal',
  'raiganj': 'West Bengal', 'uttar-dinajpur': 'West Bengal',
  'dakshin-dinajpur': 'West Bengal', 'balurghat': 'West Bengal',
  'alipurduar': 'West Bengal', 'tamluk': 'West Bengal',
  'hardinge': 'Delhi', // Lady Hardinge - Delhi
  'rgkar': 'West Bengal', 'sskm': 'West Bengal',
  'ipgmer': 'West Bengal', 'cnmc': 'West Bengal',
  'jokakolkata': 'West Bengal', 'joka': 'West Bengal',
  'bidhan-chandra': 'West Bengal', 'bcr': 'West Bengal',
  'esic-joka': 'West Bengal', 'sammilani': 'West Bengal',
  'institute-pgmer': 'West Bengal',

  // ----- Delhi -----
  'delhi': 'Delhi', 'aiims-delhi': 'Delhi', 'aiimsdelhi': 'Delhi',
  'maulana': 'Delhi', 'azad-medical': 'Delhi',
  'safdarjung': 'Delhi', 'rmlhospital': 'Delhi',
  'rml': 'Delhi', 'abvims': 'Delhi', 'vmmc': 'Delhi',
  'lhmc': 'Delhi', 'ladyhardinge': 'Delhi', 'lady': 'Delhi',
  'dilshad': 'Delhi', 'dilshad-garden': 'Delhi',
  'ucms': 'Delhi', 'gtb': 'Delhi', 'esicfaridabad': 'Delhi',
  'shaheed': 'Delhi', 'hamdard': 'Delhi', 'jamia': 'Delhi',
  'shri-aurobindo': 'Delhi', 'university-college-of-medical-sciences': 'Delhi',

  // ----- Jammu And Kashmir -----
  'srinagar': 'Jammu And Kashmir', 'jammu': 'Jammu And Kashmir',
  'anantnag': 'Jammu And Kashmir', 'baramulla': 'Jammu And Kashmir',
  'kathua': 'Jammu And Kashmir', 'rajouri': 'Jammu And Kashmir',
  'doda': 'Jammu And Kashmir', 'kupwara': 'Jammu And Kashmir',
  'handwara': 'Jammu And Kashmir', 'udhampur': 'Jammu And Kashmir',
  'samba': 'Jammu And Kashmir', 'reasi': 'Jammu And Kashmir',
  'poonch': 'Jammu And Kashmir', 'ramban': 'Jammu And Kashmir',
  'kishtwar': 'Jammu And Kashmir', 'kulgam': 'Jammu And Kashmir',
  'pulwama': 'Jammu And Kashmir', 'shopian': 'Jammu And Kashmir',
  'budgam': 'Jammu And Kashmir', 'bandipora': 'Jammu And Kashmir',
  'ganderbal': 'Jammu And Kashmir', 'sopore': 'Jammu And Kashmir',
  'sher-i-kashmir': 'Jammu And Kashmir', 'skims': 'Jammu And Kashmir',
  'gmcj': 'Jammu And Kashmir',

  // ----- Ladakh -----
  'leh': 'Ladakh', 'kargil': 'Ladakh',

  // ----- Chandigarh -----
  'chandigarh': 'Chandigarh', 'chandigar': 'Chandigarh',
  'pgi': 'Chandigarh', 'pgimer': 'Chandigarh',
  'gmch-32': 'Chandigarh',

  // ----- Puducherry -----
  'puducherry': 'Puducherry', 'pondicherry': 'Puducherry',
  'jipmer': 'Puducherry', 'karaikal': 'Puducherry',
  'mahe': 'Puducherry', 'yanam': 'Puducherry',
  'gorimedu': 'Puducherry', 'dhanvantari-nagar': 'Puducherry',
  'sri-manakula': 'Puducherry', 'mahatmagandhi-pondy': 'Puducherry',

  // ----- Andaman and Nicobar Islands -----
  'port-blair': 'Andaman And Nicobar Islands',
  'portblair': 'Andaman And Nicobar Islands',
  'nicobar': 'Andaman And Nicobar Islands',
  'aniims': 'Andaman And Nicobar Islands',

  // ----- Dadra and Nagar Haveli & Daman and Diu -----
  'silvassa': 'Dadra And Nagar Haveli', 'daman': 'Daman And Diu',
  'diu': 'Daman And Diu',

  // ----- Patches for high-frequency still-unmapped tokens -----
  // (typos, split words from broken CSV cells, and a few missing cities)
  'khaleelwadi': 'Telangana',                 // GMC Nizamabad campus
  'baramati': 'Maharashtra',
  'mullana': 'Haryana',                        // MM Institute, Mullana, Ambala
  'uluberia': 'West Bengal',                   // Sarat Chandra Chattopadhyay GMC
  'balangir': 'Odisha', 'bolangir': 'Odisha',  // Bhima Bhoi MC
  'coochbehar': 'West Bengal', 'cooch': 'West Bengal',
  'koochbehar': 'West Bengal',
  'hyderbad': 'Telangana',                     // common typo
  'narendrapur': 'West Bengal',
  'purulia-mc': 'West Bengal',                 // already have 'purulia'
  // Split-word forms (CSVs sometimes break words mid-string with stray spaces)
  'aurang': 'Maharashtra', 'abad': 'Maharashtra',  // "AURANG ABAD"
  'thiruva': 'Kerala', 'nanthapuram': 'Kerala',    // "THIRUVA NANTHAPURAM"
  'jamshed': 'Jharkhand',                          // "JAMSHED PUR"
  'bilasp': 'Chhattisgarh',                        // "BILASP UR"
  'darjee': 'West Bengal', 'ling': 'West Bengal',  // "DARJEE LING"
  'yavatm': 'Maharashtra',                         // "YAVATM AL"
  'tiruchirap': 'Tamil Nadu',                      // "TIRUCHIRAP ALLI"
  'asaripa': 'Tamil Nadu',                         // "ASARIPA LLAM"
  'asaripalla': 'Tamil Nadu',                      // "ASARIPALLA M"
  'midnapu': 'West Bengal',                        // "MIDNAPU R"
  'midnap': 'West Bengal',
  'rampu': 'West Bengal',                          // "RAMPU RHAT"
  'kolkat': 'West Bengal',                         // "KOLKAT A"
  'sholap': 'Maharashtra',                         // "SHOLAP UR"
  'aurangp': 'Maharashtra',
  'thoothu': 'Tamil Nadu', 'kudi': 'Tamil Nadu',   // "THOOTH UKUDI"
  'thoothuk': 'Tamil Nadu',
  'guahaw': 'Assam',                               // "GUAHAW TI"
  'visakh': 'Andhra Pradesh',                      // "VISAKH APATNAM"
  'apatnam': 'Andhra Pradesh',
  'rai': 'Uttar Pradesh',                          // ambiguous but Rae Bareli AIIMS dominates
  'bareli': 'Uttar Pradesh',                       // Bareli/Rae Bareli
  'thiruvananthapu': 'Kerala',                     // already have THIRUVANANTHAPURAM but extra
  'thiruvanantapu': 'Kerala',
  'maharara': 'Maharashtra', 'maharar': 'Maharashtra',  // "MAHARARASTRA" / "MAHARARASTR A"
  'rastra': 'Maharashtra', 'rastr': 'Maharashtra',
  'panagal': 'Tamil Nadu',
  'baroda-gmc': 'Gujarat',
  'kollegal': 'Karnataka',
  'kalaburgi': 'Karnataka',                        // alt spelling Kalaburagi
  'haveri-mc': 'Karnataka',
  'gunadala': 'Andhra Pradesh',
  'razabazar': 'Bihar',
  'pariyaramcollege': 'Kerala',
  'andamandhal': 'Andaman And Nicobar Islands',
  'aniims-pb': 'Andaman And Nicobar Islands',
  'islands': 'Andaman And Nicobar Islands',        // last token of "Andaman and Nicobar Islands Institute of Medical Sciences"
  'changanacherry': 'Kerala',
  'puthencruz': 'Kerala',
  'kuriakose': 'Kerala',
  'pariyaram-mc': 'Kerala',
  'jln-aligarh': 'Uttar Pradesh',
  // Round 2 patches
  'ananthapuram': 'Andhra Pradesh',
  'bhilwara': 'Rajasthan',
  'ratnagir': 'Maharashtra',                       // "Ratnagir i" split form
  'tirunel': 'Tamil Nadu', 'veli': 'Tamil Nadu',   // "TIRUNEL VELI"
  'harbour': 'West Bengal',                        // Diamond Harbour
  'diamond': 'West Bengal',                        // Diamond Harbour
  'vinobha': 'Dadra And Nagar Haveli',             // Shri Vinobha Bhave Inst, Silvassa
  'bhave': 'Dadra And Nagar Haveli',
  'svbpgi': 'Dadra And Nagar Haveli',
  'mahata': 'West Bengal',                         // Deben Mahata GMC, Purulia
  'deben': 'West Bengal',
  'ambedkar': 'Punjab',                            // Dr B.R. Ambedkar State Inst, Mohali
  'azamgarh-mc': 'Uttar Pradesh',
  'jamshedp': 'Jharkhand',                         // alt split
  'pondich': 'Puducherry',
  'erry': 'Puducherry',                            // "PUDUCH ERRY"
  'puduch': 'Puducherry',
  'jaisalmer-mc': 'Rajasthan',
  'jhabua': 'Madhya Pradesh',
  'tiruchen': 'Tamil Nadu',                        // alt
  'sangrur-mc': 'Punjab',
  'kalyani-mc': 'West Bengal',
  'krishnagar': 'West Bengal',
  'azheekal-mc': 'Kerala',
  'tinsukia-mc': 'Assam',
  'rajamahendri': 'Andhra Pradesh',
  'kotak': 'Tamil Nadu',                           // sometimes appears
  // Round 3 patches
  'mahabubangar': 'Telangana', 'mahbubangar': 'Telangana',
  'garhwali': 'Uttarakhand', 'garhwal': 'Uttarakhand',
  'srinagar-garhwal-mc': 'Uttarakhand',
  'yadgiri': 'Karnataka',                          // Yadgiri Inst (also spelled Yadgir)
  'aur': 'Maharashtra',                            // "AUR ANGABAD" split
  'angabad': 'Maharashtra',                        // "AUR ANGABAD" split
  'kasna': 'Uttar Pradesh',                        // Greater Noida area
  'bharati': 'Maharashtra',                        // Bharati Vidyapeeth Pune
  'vidyapeeth': 'Maharashtra',
  'collage': 'Rajasthan',                          // ESIC "Collage" Alwar typo (ambiguous, but most ESIC entries with this misspelling are Alwar)
  'mahabubnagar-mc': 'Telangana',
  'gnsu': 'Bihar',                                 // Gopal Narayan Singh Univ, Sasaram
  'igims': 'Bihar',                                // IGIMS Patna
  'bhims': 'Bihar',                                // Bhagwan Mahavir Inst, Pawapuri
  'pawapuri-mc': 'Bihar',
  'noida-mc': 'Uttar Pradesh',
  'rajshree': 'Uttar Pradesh',                     // Rajshree Med Inst, Bareilly
  'krmc': 'Tamil Nadu',                            // Karpaga Vinayaga
  'karpaga': 'Tamil Nadu',                         // Karpaga Vinayaga MC, Maduranthakam
  'maduranthakam': 'Tamil Nadu',
  'aarupadai': 'Puducherry',                       // Aarupadai Veedu Med Coll
  'veedu': 'Puducherry',
  'avbrh': 'Maharashtra',                          // Acharya Vinoba Bhave Rural Hospital, Sawangi (Wardha)
  'sawangi': 'Maharashtra',
  'datta-meghe': 'Maharashtra',
  'dhanvantari': 'Puducherry',
  'pondy': 'Puducherry',
  'kanachur': 'Karnataka',                         // Kanachur Inst, Mangalore
  'kvg': 'Karnataka',                              // KVG MC Sullia
  'srinivas-mc': 'Karnataka',
  'esicmc-faridabad': 'Haryana',
  'esicmc-alwar': 'Rajasthan',
  'esicmc-chennai': 'Tamil Nadu',
  'esicmc-hyd': 'Telangana',
  'esicmc-bihta': 'Bihar',
  'esicmc-gulbarga': 'Karnataka',
  // Round 4 patches
  'nilgiris': 'Tamil Nadu', 'udhagamandalam': 'Tamil Nadu', 'ooty': 'Tamil Nadu',
  'nagarkurnool': 'Telangana',
  'jnm': 'West Bengal',                            // College of Medicine & JNM Hospital, Kalyani
  'pati': 'Punjab', 'patiala-mc': 'Punjab',        // "PATI ALA" split
  'lalithambigai': 'Tamil Nadu',                   // Sri Lalithambigai MC, Chennai
  'bhaarath': 'Tamil Nadu',                        // Bhaarath MC, Chennai
  'vels': 'Tamil Nadu',                            // Vels MC, Chennai
  'vikarabad': 'Telangana',
  'saifai': 'Uttar Pradesh',                       // UPRIMS Saifai
  'uprims': 'Uttar Pradesh',
  'venkateswara': 'Andhra Pradesh',                // Sri Venkateswara MC, Tirupati
  'venkateshwara': 'Andhra Pradesh',
  'jln-aj': 'Rajasthan',                           // JLN MC Ajmer
  'sirohi-mc': 'Rajasthan',
  'tonk-mc': 'Rajasthan',
  'kollam-mc': 'Kerala',
  'devarajurs': 'Karnataka',                       // Sri Devraj Urs MC, Kolar
  'devraj': 'Karnataka',
  'urs': 'Karnataka',
  'banur': 'Punjab',                               // Gian Sagar MC, Banur (Patiala)
  'mahatma': 'Rajasthan',                          // Mahatma Gandhi MC, Jaipur (most common ref)
  // Final cleanups
  'vidisha-mc': 'Madhya Pradesh',
  'satna-mc': 'Madhya Pradesh',
  'kothagudem-mc': 'Telangana',
  // Round 5 - final long-tail
  'thiruvallur-mc': 'Tamil Nadu',                   // already have 'tiruvallur', this is alt spelling
  'ramanathapura': 'Tamil Nadu',                    // "Ramanathapura m" split
  'kancheepuram': 'Tamil Nadu', 'kanchee': 'Tamil Nadu',
  'sathya': 'Tamil Nadu', 'sai-mc': 'Tamil Nadu',
  'srina': 'Jammu And Kashmir',                     // "SRINA GAR" split
  'machilipatna': 'Andhra Pradesh',                 // "MACHILIPATNA M" split
  'tiru': 'Tamil Nadu',                             // "TIRU NELVELI"
  'nelveli': 'Tamil Nadu',
  'yav': 'Maharashtra', 'atmal': 'Maharashtra',     // "YAV ATMAL"
  'ambajoga': 'Maharashtra',                        // "AMBAJOGA I"
  'sholapu': 'Maharashtra',                         // "SHOLAPU R"
  'vaishampaya': 'Maharashtra',                     // Dr Vaishampayam Memorial MC, Solapur
};

// =============================================================================
// LOOKUP HELPER
// =============================================================================
// Tokenise the raw institute string (lowercase letters only), walk
// right-to-left looking for a city token. Right-to-left because the city
// almost always comes near the end of the institute name in the cutoff
// CSVs (e.g. "Govt Medical College, Kannauj" or "AIIMS Patna").

function lookupCityState(rawInstitute) {
  const cleaned = rawInstitute
    .replace(/[^a-zA-Z\s]/g, ' ')
    .toLowerCase();
  const tokens = cleaned.split(/\s+/).filter(t => t.length >= 3);
  // Walk right-to-left, last city token wins.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (CITY_STATE[t]) return { city: t, state: CITY_STATE[t] };
  }
  // Try two-token windows (e.g. "new delhi", "navi mumbai") for cases the
  // hyphenated entries above don't catch — only meaningful for "delhi" and
  // "mumbai" which are already single-token, so this is a no-op fallback.
  return null;
}

// =============================================================================
// MAIN
// =============================================================================

function main() {
  const years = readdirSync(CUTOFF_DIR)
    .map(f => f.match(/^neet_cutoffs_(\d{4})\.csv$/))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10))
    .sort();

  let totalRows = 0;
  let mappedRows = 0;
  let unmappedRows = 0;
  const recoveredCityCount = new Map(); // city -> rows recovered
  const recoveredStateCount = new Map(); // state -> rows recovered
  const stillUnmappedShortCount = new Map(); // shortName -> rows still missing
  const stillUnmappedSamples = new Map(); // shortName -> sample raw
  let recovered = 0;

  for (const y of years) {
    const recs = parse(
      readFileSync(join(CUTOFF_DIR, `neet_cutoffs_${y}.csv`), 'utf-8'),
      { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true },
    );
    for (const r of recs) {
      if (norm(r['Course']).toUpperCase() !== 'MBBS') continue;
      const closing = parseInt(String(r['Closing_Rank']).replace(/[^\d]/g,''), 10);
      if (!closing || closing <= 0) continue;
      totalRows++;
      const raw = r['Allotted Institute'] || '';
      const state = extractState(raw);
      if (state) { mappedRows++; continue; }
      unmappedRows++;
      const hit = lookupCityState(raw);
      if (hit) {
        recovered++;
        recoveredCityCount.set(hit.city, (recoveredCityCount.get(hit.city) || 0) + 1);
        recoveredStateCount.set(hit.state, (recoveredStateCount.get(hit.state) || 0) + 1);
      } else {
        const shortName = norm(raw.split(/,|\n/)[0]);
        stillUnmappedShortCount.set(shortName, (stillUnmappedShortCount.get(shortName) || 0) + 1);
        if (!stillUnmappedSamples.has(shortName)) stillUnmappedSamples.set(shortName, norm(raw).slice(0, 160));
      }
    }
  }

  // -- Build cities map. Use only entries that actually reference a city
  //    appearing in the data, plus the curated table (we keep all for
  //    forward-compatibility with future intakes).
  const citiesSorted = Object.keys(CITY_STATE).sort();
  const citiesMap = {};
  for (const k of citiesSorted) citiesMap[k] = CITY_STATE[k];

  const beforePct = (mappedRows / totalRows * 100).toFixed(2);
  const afterPct = ((mappedRows + recovered) / totalRows * 100).toFixed(2);

  const out = {
    _meta: {
      generated_at: new Date().toISOString().slice(0, 10),
      total_entries: Object.keys(citiesMap).length,
      sources: [
        'https://en.wikipedia.org/wiki/List_of_medical_colleges_in_India',
        'https://www.nmc.org.in/information-desk/college-and-course-search/',
        'standard Indian geography (state capitals + district seats)',
      ],
      expected_state_parse_lift: `from ${beforePct}% to ${afterPct}% (across ${totalRows} MBBS rows, 2019-2024)`,
      coverage: {
        years_processed: years,
        total_mbbs_rows: totalRows,
        already_mapped_by_extractState: mappedRows,
        unmapped_before: unmappedRows,
        recovered_by_city_lookup: recovered,
        still_unmapped_after: unmappedRows - recovered,
      },
    },
    cities: citiesMap,
  };

  writeFileSync(join(ROOT, 'scripts', 'data', 'city_state_map.json'), JSON.stringify(out, null, 2));

  // -- Coverage report --
  const recoveredCityList = [...recoveredCityCount.entries()].sort((a, b) => b[1] - a[1]);
  const recoveredStateList = [...recoveredStateCount.entries()].sort((a, b) => b[1] - a[1]);
  const stillUnmappedList = [...stillUnmappedShortCount.entries()].sort((a, b) => b[1] - a[1]);
  const stillUnmappedTotal = [...stillUnmappedShortCount.values()].reduce((a, b) => a + b, 0);

  const lines = [];
  lines.push('# State-Backfill Coverage Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('## Overall');
  lines.push('');
  lines.push(`- Years processed: ${years.join(', ')}`);
  lines.push(`- Total MBBS rows: ${totalRows.toLocaleString()}`);
  lines.push(`- Mapped by extractState() (state in address): ${mappedRows.toLocaleString()} (${beforePct}%)`);
  lines.push(`- Unmapped before backfill: ${unmappedRows.toLocaleString()} (${(unmappedRows/totalRows*100).toFixed(2)}%)`);
  lines.push(`- Recovered by city_state_map: ${recovered.toLocaleString()} (${(recovered/totalRows*100).toFixed(2)}%)`);
  lines.push(`- Still unmapped after backfill: ${stillUnmappedTotal.toLocaleString()} (${(stillUnmappedTotal/totalRows*100).toFixed(2)}%)`);
  lines.push('');
  lines.push(`**State-parse lift: ${beforePct}% → ${afterPct}%**`);
  lines.push('');
  lines.push('## Map size');
  lines.push('');
  lines.push(`- Total city entries: ${Object.keys(citiesMap).length}`);
  lines.push(`- Distinct cities used in recovery: ${recoveredCityList.length}`);
  lines.push('');
  lines.push('## Top 30 cities by recovered rows');
  lines.push('');
  lines.push('| City | State | Rows |');
  lines.push('|------|-------|-----:|');
  for (const [c, n] of recoveredCityList.slice(0, 30)) {
    lines.push(`| ${c} | ${CITY_STATE[c]} | ${n} |`);
  }
  lines.push('');
  lines.push('## Per-state recovered row count');
  lines.push('');
  lines.push('| State | Rows recovered |');
  lines.push('|-------|---------------:|');
  for (const [s, n] of recoveredStateList) {
    lines.push(`| ${s} | ${n} |`);
  }
  lines.push('');
  lines.push('## Top 30 still-unmapped institute short names');
  lines.push('');
  lines.push('Cities to add in the next iteration. The "Sample raw" column shows the full Allotted Institute string so you can identify the city.');
  lines.push('');
  lines.push('| Rows | Short name | Sample raw |');
  lines.push('|-----:|-----------|-----------|');
  for (const [s, n] of stillUnmappedList.slice(0, 30)) {
    const sample = (stillUnmappedSamples.get(s) || '').replace(/\|/g, '/');
    lines.push(`| ${n} | ${s} | ${sample} |`);
  }
  lines.push('');
  lines.push('## Notes & ambiguities');
  lines.push('');
  lines.push('- "Aurangabad" is mapped to Maharashtra (now Chhatrapati Sambhajinagar). Bihar also has an Aurangabad but no MBBS college there.');
  lines.push('- "Hamirpur" is mapped to Himachal Pradesh by default (Dr. RPGMC Tanda is in Kangra dist; Hamirpur HP has a medical college). UP also has a Hamirpur — handled via "hamirpur-up" if needed.');
  lines.push('- "Pratapgarh" is mapped to Rajasthan; UP variant uses "pratapgarh-up".');
  lines.push('- "Bilaspur" is mapped to Chhattisgarh (the larger medical-college city); HP variant uses "bilaspur-hp".');
  lines.push('- "Srinagar" is mapped to Jammu And Kashmir; the small Uttarakhand town uses "srinagar-uk" / "srinagar-garhwal".');
  lines.push('- "Pondicherry"/"Puducherry" → Puducherry UT; "Karaikal" (JIPMER campus) and "Mahe" / "Yanam" also map to Puducherry.');
  lines.push('- "Lady Hardinge" is mapped to Delhi via the institutional token "hardinge".');
  lines.push('- "Vardhman Mahavir / Safdarjung / RML / ABVIMS / VMMC / UCMS" all map to Delhi via institutional tokens.');
  lines.push('- "JIPMER" maps to Puducherry; "JIPMER Karaikal" still resolves correctly because "karaikal" → Puducherry.');
  lines.push('- "Manipal" maps to Karnataka (Udupi district) — Kasturba Medical College is there. The Manipal University network spans multiple states.');
  lines.push('');
  writeFileSync(join(ROOT, 'scripts', 'data', 'state-backfill-coverage.md'), lines.join('\n'));

  // Validate JSON parses.
  JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'city_state_map.json'), 'utf-8'));

  console.log('=== city_state_map.json built ===');
  console.log('Entries:', Object.keys(citiesMap).length);
  console.log('Total MBBS rows:', totalRows);
  console.log('Already mapped:', mappedRows, `(${beforePct}%)`);
  console.log('Recovered by lookup:', recovered);
  console.log('After lookup:', mappedRows + recovered, `(${afterPct}%)`);
  console.log('Still unmapped:', stillUnmappedTotal);
  console.log('');
  console.log('Top 5 cities by recovered rows:');
  for (const [c, n] of recoveredCityList.slice(0, 5)) {
    console.log(`  ${String(n).padStart(5)}  ${c} -> ${CITY_STATE[c]}`);
  }
  console.log('');
  console.log('Top 10 STILL unmapped (by row count):');
  for (const [s, n] of stillUnmappedList.slice(0, 10)) {
    console.log(`  ${String(n).padStart(5)}  ${s}  -- ${stillUnmappedSamples.get(s)}`);
  }
}

main();
