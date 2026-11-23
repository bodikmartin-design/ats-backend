/**
 * General roles found at blockchain / Web3 projects: protocols, exchanges, wallets, DeFi, N"" and gaming teams.
 * [title, department, employment type, description]. Edit them in the admin UI a""er importing.
 */
export const BLOCKCHAIN_COMPANY = {
  name: "Blockchain Project",
  description: "A blockchain project building open, decentralized products. Edit this description under Companies.",
  location: "New York, NY, USA",
};

const FT = "Full-time";
const PT = "Part-time";
const CT = "Contract";

export const BLOCKCHAIN_ROLES = [
  // ---- Leadership
  ["Chief Executive Officer (CEO)", "Leadership", "", "Sets the vision and strategy for the project, leads the executive team, and represents the project to investors, partners and the community."],
  ["Chief Technology Officer (CTO)", "Leadership", "", "Owns the technical vision, protocol architecture and engineering organization, and keeps the platform secure, scalable and shippable."],
  ["Chief Product Officer (CPO)", "Leadership", "", "Defines the product strategy and roadmap across the protocol, apps and tooling, balancing user needs with on-chain constraints."],
  ["Chief Operating Officer (COO)", "Leadership", "", "Runs day-to-day operations, aligns teams on priorities and builds the processes that let a fast-moving Web3 team scale."],
  ["Chief Financial Officer (CFO)", "Leadership", "", "Manages treasury, budgeting, token and fiat finances, reporting and relationships with auditors and banking partners."],
  ["Chief Marketing Officer (CMO)", "Leadership", "", "Leads brand, growth and community strategy and turns the project's story into adoption."],
  ["Chief Compliance Officer (CCO)", "Leadership", "", "Builds and runs the compliance program covering AML/KYC, sanctions, licensing and regulatory engagement."],
  ["VP of Engineering", "Leadership", "", "Leads engineering managers and delivery across protocol, backend, frontend and infrastructure teams."],
  ["Head of Growth", "Leadership", "", "Owns user acquisition, activation and retention across on-chain and off-chain channels."],
  ["Head of Business Development", "Leadership", "", "Leads partnerships, integrations, listings and ecosystem deals."],

  // ---- Protocol & core engineering
  ["Blockchain Engineer", "Engineering", "", "Designs and builds blockchain infrastructure, node software and on-chain services in a language such as Go, Rust or TypeScript."],
  ["Core Protocol Engineer", "Engineering", "", "Works on the protocol itself: consensus, networking, state management, performance and upgrades."],
  ["Blockchain Architect", "Engineering", "", "Designs end-to-end system architecture across chains, contracts, indexers, APIs and client apps."],
  ["Consensus Engineer", "Engineering", "", "Implements and tests consensus and finality mechanisms, validator logic and fork-choice rules."],
  ["Cryptography Engineer", "Engineering", "", "Implements cryptographic primitives and protocols such as signatures, hashing, threshold schemes and key management."],
  ["Zero-Knowledge (ZK) Engineer", "Engineering", "", "Builds zero-knowledge circuits, provers and verifiers for rollups, privacy and scaling systems."],
  ["Layer 2 / Rollup Engineer", "Engineering", "", "Builds sequencers, provers, bridges and tooling for optimistic and ZK rollups."],
  ["Cross-Chain / Bridge Engineer", "Engineering", "", "Designs and maintains cross-chain messaging and bridge systems with a strong security mindset."],
  ["Node & Validator Operations Engineer", "Engineering", "", "Runs and monitors validators and RPC nodes, handles upgrades, slashing risk and uptime."],
  ["Blockchain Research Engineer", "Engineering", "", "Prototypes new protocol ideas, benchmarks them and turns research into working code."],

  // ---- Smart contracts
  ["Smart Contract Engineer (Solidity)", "Engineering", "", "Writes, tests and deploys EVM smart contracts with a focus on gas efficiency and security."],
  ["Smart Contract Engineer (Rust)", "Engineering", "", "Builds on-chain programs for Solana, NEAR or CosmWasm using Rust, with strong testing practice."],
  ["Move Engineer", "Engineering", "", "Develops smart contracts in Move for Aptos or Sui and designs safe resource models."],
  ["Smart Contract Auditor", "Security", "", "Reviews smart contracts for vulnerabilities, writes clear audit reports and helps teams fix issues."],
  ["DeFi Protocol Engineer", "Engineering", "", "Implements lending, AMM, staking, derivatives and vault logic with attention to economic attack surfaces."],

  // ---- Application engineering
  ["Full-Stack dApp Engineer", "Engineering", "", "Builds decentralized applications end to end, from contracts and indexing to the user interface."],
  ["Web3 Frontend Engineer", "Engineering", "", "Builds fast, accessible interfaces that connect to wallets and chains using React or Next.js and libraries like ethers, viem or wagmi."],
  ["Backend Engineer (Blockchain Infrastructure)", "Engineering", "", "Builds APIs, indexers, event pipelines and services that read from and write to blockchains."],
  ["Wallet Engineer", "Engineering", "", "Builds self-custodial or smart-contract wallets, including key handling, signing flows and account abstraction."],
  ["Mobile Engineer (Web3)", "Engineering", "", "Builds iOS or Android apps and wallets that interact with blockchain networks."],
  ["SDK & Developer Tools Engineer", "Engineering", "", "Creates SDKs, CLIs and libraries that make it easy for other developers to build on the project."],
  ["Blockchain Data Engineer", "Engineering", "", "Builds pipelines and warehouses for on-chain data, indexing and analytics."],
  ["DevOps / Site Reliability Engineer", "Engineering", "", "Owns infrastructure, CI/CD, observability and incident response for nodes and services."],
  ["QA / Test Automation Engineer", "Engineering", "", "Designs automated tests for contracts, APIs and apps, including fuzzing and testnet simulations."],
  ["Engineering Manager", "Engineering", "", "Leads a team of engineers, grows them, and keeps delivery predictable and secure."],
  ["Game Developer (Web3 Games)", "Engineering", "", "Builds game clients and systems that integrate NFTs, tokens and on-chain items."],

  // ---- Security
  ["Security Engineer", "Security", "", "Hardens applications and infrastructure, runs threat modelling and builds security tooling."],
  ["Security Researcher", "Security", "", "Finds and analyzes vulnerabilities in contracts, protocols and wallets, and publishes findings."],
  ["Bug Bounty & Vulnerability Program Manager", "Security", "", "Runs the bug bounty program, triages reports and coordinates fixes and disclosures."],
  ["Incident Response & Threat Intelligence Analyst", "Security", "", "Monitors for exploits and suspicious activity and leads response when something goes wrong."],
  ["Penetration Tester", "Security", "", "Tests web apps, APIs and infrastructure for weaknesses and reports practical fixes."],

  // ---- Product & design
  ["Product Manager (Web3)", "Product", "", "Owns a product area from discovery to launch, working with engineering, design and the community."],
  ["Technical Product Manager (Protocol)", "Product", "", "Translates protocol and developer needs into a clear roadmap and specifications."],
  ["Product Designer (UI/UX)", "Design", "", "Designs clear, trustworthy interfaces for wallets, trading and onboarding flows."],
  ["Brand & Visual Designer", "Design", "", "Creates the visual identity, marketing assets and launch materials for the project."],
  ["NFT Artist / 3D Designer", "Design", "", "Creates collectible art, characters and 3D assets for NFTs and gaming projects."],
  ["Game Designer (GameFi)", "Design", "", "Designs game loops, progression and in-game economies that work with tokens and NFTs."],
  ["Technical Writer / Documentation Engineer", "Product", "", "Writes and maintains developer docs, tutorials and API references."],
  ["Business Analyst", "Product", "", "Gathers requirements, analyzes data and helps teams make clear, evidence-based decisions."],

  // ---- Research, tokenomics & data
  ["Tokenomics Designer / Token Engineer", "Research", "", "Designs and simulates token supply, incentives and governance mechanisms."],
  ["Blockchain Researcher", "Research", "", "Studies protocols, markets and ecosystems and publishes research for the team and community."],
  ["Quantitative Researcher (DeFi)", "Research", "", "Models market, liquidity and risk dynamics for DeFi products."],
  ["On-Chain Data Analyst", "Research", "", "Analyzes blockchain data to understand users, liquidity and protocol health, and builds dashboards."],
  ["Data Scientist", "Research", "", "Builds models and analyses to improve products, detect fraud and forecast growth."],

  // ---- Finance & trading
  ["DeFi Strategist", "Finance", "", "Designs yield, liquidity and treasury strategies across DeFi protocols."],
  ["Quantitative Trader", "Finance", "", "Develops and runs systematic trading strategies on centralized and decentralized venues."],
  ["Market Maker / Liquidity Manager", "Finance", "", "Manages liquidity and market-making relationships to keep markets healthy."],
  ["Treasury Manager", "Finance", "", "Manages the project treasury across fiat, stablecoins and tokens, including custody and risk controls."],
  ["Risk Analyst", "Finance", "", "Assesses protocol, counterparty and market risk and sets limits and monitoring."],
  ["Finance Manager / Controller", "Finance", "", "Runs accounting, reporting, payroll and audits for a crypto-native organization."],
  ["Crypto Tax & Accounting Specialist", "Finance", "", "Handles accounting and tax treatment of token and on-chain transactions."],
  ["Investor Relations Manager", "Finance", "", "Manages investor communication, reporting and fundraising materials."],

  // ---- Legal, compliance & governance
  ["Legal Counsel (Digital Assets)", "Legal", "", "Advises on token, securities, contract and IP matters for blockchain products."],
  ["Compliance Officer (AML/KYC)", "Compliance", "", "Runs onboarding, transaction monitoring and reporting to meet AML and KYC obligations."],
  ["Regulatory Affairs Manager", "Compliance", "", "Tracks regulation across regions and engages with regulators and industry bodies."],
  ["Data Protection & Privacy Officer", "Compliance", "", "Ensures the project handles personal data lawfully and transparently."],
  ["DAO Governance Lead", "Governance", "", "Coordinates proposals, voting and delegate programs and keeps governance healthy and transparent."],
  ["Policy Analyst", "Governance", "", "Researches policy developments and helps shape the project's public positions."],

  // ---- Growth, marketing & community
  ["Marketing Manager", "Marketing", "", "Plans and runs campaigns across channels to grow awareness and adoption."],
  ["Growth Marketing Manager", "Marketing", "", "Runs experiments across acquisition, onboarding and retention funnels."],
  ["Content Writer / Crypto Journalist", "Marketing", "", "Writes articles, newsletters and explainers that make complex topics clear."],
  ["Social Media Manager", "Marketing", "", "Runs the project's social channels and builds an engaged audience."],
  ["PR & Communications Manager", "Marketing", "", "Manages press, announcements and crisis communication."],
  ["KOL & Influencer Manager", "Marketing", "", "Builds relationships with creators and communities and manages sponsored campaigns."],
  ["Community Manager", "Community", "", "Builds and supports the community on Discord, Telegram and X, and brings feedback to the team."],
  ["Community Moderator", "Community", "", "Keeps community channels safe and helpful, and spots scams and spam."],
  ["Developer Relations Engineer (DevRel)", "Community", "", "Helps developers succeed with the project through demos, talks, samples and feedback."],
  ["Developer Advocate", "Community", "", "Creates tutorials, hosts workshops and represents developers inside the team."],
  ["Ecosystem Manager", "Business Development", "", "Grows the ecosystem of builders, partners and integrations around the project."],
  ["Grants Program Manager", "Business Development", "", "Runs the grants program: sourcing, evaluating, funding and supporting projects."],
  ["Partnerships Manager", "Business Development", "", "Finds, negotiates and manages partnerships and integrations."],
  ["Events & Hackathon Manager", "Community", "", "Plans conferences, meetups and hackathons that bring builders together."],

  // ---- Operations & people
  ["Operations Manager", "Operations", "", "Keeps teams, tools and processes running smoothly across time zones."],
  ["Project Manager / Scrum Master", "Operations", "", "Plans work, removes blockers and keeps delivery on track."],
  ["Program Manager", "Operations", "", "Coordinates multi-team initiatives such as launches, audits and network upgrades."],
  ["Customer Support Specialist (Web3)", "Operations", "", "Helps users with wallets, transactions and account issues and spots scams."],
  ["Technical Recruiter (Web3)", "People", "", "Sources and hires engineers and other specialists for blockchain teams."],
  ["Talent Acquisition Lead", "People", "", "Builds the hiring strategy and process and leads recruiters and hiring managers."],
  ["HR Business Partner", "People", "", "Supports managers and employees with people processes in a remote, global team."],
  ["Executive Assistant", "Operations", "", "Supports executives with scheduling, travel, communication and day-to-day coordination."],
];
