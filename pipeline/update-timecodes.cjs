require('dotenv').config();
const fs = require('fs');

const ACT_STARTS = {
  act1:  0,
  act2:  3738,
  act3:  7972,
  act3b: 12362,
  act4:  13759,
  act5:  19247,
  end:   25151,
};

const FPS = 30;

function framesToTC(frames) {
  const totalSec = Math.floor(frames / FPS);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const f = frames % FPS;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(f).padStart(2,'0')}`;
}

const SCENE_DEFS = [
  { id: 'EP3_S001', act: 'act1', clip: 'EP3_01A_OPENING_CryptoSkyline.mp4',      vo: 'VO_Act1.mp3',  dur: 400, text: { line1: 'NOVEMBER 2022', line2: 'THE WORLD HAD A NEW HERO', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'cold_blue',    kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Opening shot' },
  { id: 'EP3_S002', act: 'act1', clip: 'EP3_01B_OPENING_CryptoSkyline.mp4',      vo: null,            dur: 350, text: { line1: 'EMPIRE OMITTED', line2: null, font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'cold_blue',    kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Channel branding' },
  { id: 'EP3_S003', act: 'act1', clip: 'EP3_02A_ACT1_SBF-Portrait.mp4',          vo: 'VO_Act1.mp3',  dur: 380, text: { line1: 'SAM BANKMAN-FRIED', line2: 'FOUNDER — FTX', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, lower: { name: 'SAM BANKMAN-FRIED', title: 'Founder & CEO, FTX', fade_in_frames: 12, hold_frames: 90, fade_out_frames: 12 }, grade: 'cold_blue', kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'SBF portrait' },
  { id: 'EP3_S004', act: 'act1', clip: 'EP3_02B_ACT1_SBF-Portrait.mp4',          vo: null,            dur: 350, text: null, grade: 'cold_blue',    kb: { start_scale: 1.06, end_scale: 1.12, direction: 'zoom_in' }, notes: 'SBF portrait 2' },
  { id: 'EP3_S005', act: 'act1', clip: 'EP3_38A_ACT1_MITCampus.mp4',             vo: 'VO_Act1.mp3',  dur: 380, text: { line1: 'MIT — CLASS OF 2014', line2: null, font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'gold_warm',    kb: { start_scale: 1.0, end_scale: 1.05, direction: 'pan_right' }, notes: 'MIT campus' },
  { id: 'EP3_S006', act: 'act1', clip: 'EP3_03A_ACT1_EffectiveAltruism.mp4',     vo: 'VO_Act1.mp3',  dur: 400, text: { line1: 'EFFECTIVE ALTRUISM', line2: 'EARN TO GIVE', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'gold_warm',    kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Effective altruism' },
  { id: 'EP3_S007', act: 'act1', clip: 'EP3_03B_ACT1_EffectiveAltruism.mp4',     vo: null,            dur: 350, text: null, grade: 'gold_warm',    kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Altruism 2' },
  { id: 'EP3_S008', act: 'act1', clip: 'EP3_04A_ACT1_AlamedaResearch.mp4',       vo: 'VO_Act1.mp3',  dur: 370, text: { line1: '2017', line2: 'THE ARBITRAGE OPPORTUNITY', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'cold_blue',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'pan_left' }, notes: 'Trading screens' },
  { id: 'EP3_S009', act: 'act1', clip: 'EP3_04B_ACT1_AlamedaResearch.mp4',       vo: null,            dur: 360, stat: { label: 'BITCOIN ARBITRAGE', value: '+10% PER TRADE', sub: 'US vs Japan Exchange Spread 2017' }, grade: 'cold_blue',    kb: { start_scale: 1.06, end_scale: 1.12, direction: 'zoom_in' }, notes: 'Arbitrage stat' },
  { id: 'EP3_S010', act: 'act1', clip: 'EP3_04A_ACT1_AlamedaResearch.mp4',       vo: null,            dur: 348, text: { line1: 'ALAMEDA RESEARCH', line2: 'FOUNDED 2017', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'cold_blue',    kb: { start_scale: 1.0, end_scale: 1.05, direction: 'pan_right' }, notes: 'Alameda founding' },
  { id: 'EP3_S011', act: 'act2', clip: 'EP3_05A_ACT2_FTXLaunch.mp4',             vo: 'VO_Act2.mp3',  dur: 320, text: { line1: '2019', line2: 'FTX LAUNCHES', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'cold_blue',    kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'FTX launch' },
  { id: 'EP3_S012', act: 'act2', clip: 'EP3_05B_ACT2_FTXLaunch.mp4',             vo: null,            dur: 290, stat: { label: 'DAILY TRADING VOLUME', value: '$10 BILLION+', sub: 'FTX at Peak 2021' }, grade: 'cold_blue',    kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'FTX volume stat' },
  { id: 'EP3_S013', act: 'act2', clip: 'EP3_06A_ACT2_FTXArena.mp4',              vo: 'VO_Act2.mp3',  dur: 310, text: { line1: '$435 MILLION', line2: 'NAMING RIGHTS DEAL', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'gold_warm',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'FTX Arena' },
  { id: 'EP3_S014', act: 'act2', clip: 'EP3_06B_ACT2_FTXArena.mp4',              vo: null,            dur: 290, text: null, grade: 'gold_warm',    kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Arena crowd' },
  { id: 'EP3_S015', act: 'act2', clip: 'EP3_31A_ACT2_F1Sponsorship.mp4',         vo: 'VO_Act2.mp3',  dur: 270, text: null, grade: 'gold_warm',    kb: { start_scale: 1.0, end_scale: 1.10, direction: 'zoom_in' }, notes: 'F1 car' },
  { id: 'EP3_S016', act: 'act2', clip: 'EP3_07A_ACT2_CelebrityEndorsements.mp4', vo: 'VO_Act2.mp3',  dur: 310, text: { line1: 'TOM BRADY. STEPHEN CURRY.', line2: "LARRY DAVID. SHAQUILLE O'NEAL.", font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'gold_warm',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'pan_right' }, notes: 'Celebrities' },
  { id: 'EP3_S017', act: 'act2', clip: 'EP3_07B_ACT2_CelebrityEndorsements.mp4', vo: null,            dur: 280, stat: { label: 'CELEBRITY ENDORSEMENT VALUE', value: '$100M+', sub: 'Combined FTX ambassador deals' }, grade: 'gold_warm',    kb: { start_scale: 1.06, end_scale: 1.0, direction: 'pan_left' }, notes: 'Celebrity stat' },
  { id: 'EP3_S018', act: 'act2', clip: 'EP3_08A_ACT2_WashingtonDC.mp4',          vo: 'VO_Act2.mp3',  dur: 320, text: { line1: 'WASHINGTON DC', line2: '2ND LARGEST DEMOCRATIC DONOR', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Capitol building' },
  { id: 'EP3_S019', act: 'act2', clip: 'EP3_08B_ACT2_WashingtonDC.mp4',          vo: null,            dur: 280, stat: { label: 'POLITICAL DONATIONS', value: '$40 MILLION', sub: 'SBF campaign contributions 2021-2022' }, grade: 'deep_shadow',  kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Political stat' },
  { id: 'EP3_S020', act: 'act2', clip: 'EP3_09A_ACT2_ValuationBoard.mp4',        vo: 'VO_Act2.mp3',  dur: 310, text: { line1: '$32 BILLION', line2: 'PEAK VALUATION 2022', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Valuation chart' },
  { id: 'EP3_S021', act: 'act2', clip: 'EP3_09B_ACT2_ValuationBoard.mp4',        vo: null,            dur: 280, stat: { label: 'INVESTORS', value: 'SEQUOIA · SOFTBANK · BLACKROCK', sub: 'The smartest money in the world' }, grade: 'deep_shadow',  kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Investor stat' },
  { id: 'EP3_S022', act: 'act2', clip: 'EP3_10A_ACT2_BahamasHQ.mp4',             vo: 'VO_Act2.mp3',  dur: 320, text: { line1: 'THE BAHAMAS', line2: '$30M PENTHOUSE — CUSTOMER FUNDS', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'gold_warm',    kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Bahamas compound' },
  { id: 'EP3_S023', act: 'act2', clip: 'EP3_32A_ACT2_PenthouseSuite.mp4',        vo: null,            dur: 290, text: null, grade: 'gold_warm',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'pan_right' }, notes: 'Penthouse interior' },
  { id: 'EP3_S024', act: 'act2', clip: 'EP3_10B_ACT2_BahamasHQ.mp4',             vo: null,            dur: 264, text: { line1: 'PAID FOR BY CUSTOMERS', line2: null, font: 'Impact', colour: '#8B0000', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'red_alert',    kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'IMPACT WORD' },
  { id: 'EP3_S025', act: 'act3', clip: 'EP3_11A_ACT3_SecretDoor.mp4',            vo: 'VO_Act3.mp3',  dur: 390, text: { line1: 'BEHIND THE SCENES', line2: 'THE TRUTH HIDDEN IN PLAIN SIGHT', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Act 3 opens' },
  { id: 'EP3_S026', act: 'act3', clip: 'EP3_11B_ACT3_SecretDoor.mp4',            vo: null,            dur: 350, text: null, grade: 'deep_shadow',  kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Push through door' },
  { id: 'EP3_S027', act: 'act3', clip: 'EP3_12A_ACT3_AlamedaFundFlow.mp4',       vo: 'VO_Act3.mp3',  dur: 370, text: { line1: 'CUSTOMER FUNDS', line2: 'SECRETLY TRANSFERRED TO ALAMEDA', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'red_alert',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Fund flow' },
  { id: 'EP3_S028', act: 'act3', clip: 'EP3_39A_ACT3_CustomerFunds.mp4',         vo: 'VO_Act3.mp3',  dur: 360, stat: { label: 'ALAMEDA BORROWED', value: '$10 BILLION+', sub: 'From FTX customer deposits' }, grade: 'red_alert',    kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Customer funds' },
  { id: 'EP3_S029', act: 'act3', clip: 'EP3_12B_ACT3_AlamedaFundFlow.mp4',       vo: null,            dur: 350, text: null, grade: 'red_alert',    kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Secret pipe' },
  { id: 'EP3_S030', act: 'act3', clip: 'EP3_13A_ACT3_FTTToken.mp4',              vo: 'VO_Act3.mp3',  dur: 380, text: { line1: 'FTT TOKEN', line2: 'MANUFACTURED COLLATERAL', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.10, direction: 'zoom_in' }, notes: 'FTT token' },
  { id: 'EP3_S031', act: 'act3', clip: 'EP3_13B_ACT3_FTTToken.mp4',              vo: null,            dur: 350, text: { line1: 'A HOUSE OF CARDS', line2: null, font: 'Impact', colour: '#C9A84C', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'deep_shadow',  kb: { start_scale: 1.10, end_scale: 1.0, direction: 'zoom_out' }, notes: 'House of cards' },
  { id: 'EP3_S032', act: 'act3', clip: 'EP3_33A_ACT3_LedgerManipulation.mp4',    vo: 'VO_Act3.mp3',  dur: 360, text: { line1: 'THE BALANCE SHEET', line2: 'NUMBERS ALTERED TO HIDE THE TRUTH', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.06, direction: 'pan_right' }, notes: 'Ledger manipulation' },
  { id: 'EP3_S033', act: 'act3', clip: 'EP3_14A_ACT3_CarolineEllison.mp4',       vo: 'VO_Act3.mp3',  dur: 370, text: { line1: 'CAROLINE ELLISON', line2: 'CEO — ALAMEDA RESEARCH', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, lower: { name: 'CAROLINE ELLISON', title: 'CEO, Alameda Research (2021-2022)', fade_in_frames: 12, hold_frames: 90, fade_out_frames: 12 }, grade: 'cold_blue', kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Caroline Ellison' },
  { id: 'EP3_S034', act: 'act3', clip: 'EP3_14B_ACT3_CarolineEllison.mp4',       vo: null,            dur: 340, text: null, grade: 'cold_blue',    kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Ellison 2' },
  { id: 'EP3_S035', act: 'act3', clip: 'EP3_15A_ACT3_BackdoorSystem.mp4',        vo: 'VO_Act3.mp3',  dur: 370, text: { line1: 'THE BACKDOOR', line2: 'HIDDEN IN THE CODE', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Code backdoor' },
  { id: 'EP3_S036', act: 'act3', clip: 'EP3_15B_ACT3_BackdoorSystem.mp4',        vo: null,            dur: 340, text: { line1: 'UNLIMITED. INVISIBLE. ILLEGAL.', line2: null, font: 'Impact', colour: '#8B0000', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'red_alert',    kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Impact words' },
  { id: 'EP3_S037', act: 'act3b', clip: 'EP3_16A_ACT3B_EmptyWallet.mp4',         vo: 'VO_Act3B.mp3', dur: 360, text: { line1: 'OVER 1 MILLION CUSTOMERS', line2: 'LOST EVERYTHING OVERNIGHT', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'desaturated',  kb: { start_scale: 1.0, end_scale: 1.04, direction: 'zoom_in' }, notes: 'Human cost opens' },
  { id: 'EP3_S038', act: 'act3b', clip: 'EP3_16B_ACT3B_EmptyWallet.mp4',         vo: null,            dur: 340, text: null, grade: 'desaturated',  kb: { start_scale: 1.04, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Table with bills' },
  { id: 'EP3_S039', act: 'act3b', clip: 'EP3_17A_ACT3B_LockedOut.mp4',           vo: 'VO_Act3B.mp3', dur: 360, text: { line1: 'WITHDRAWALS SUSPENDED', line2: '$8 BILLION — GONE', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'desaturated',  kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Locked vault' },
  { id: 'EP3_S040', act: 'act3b', clip: 'EP3_17B_ACT3B_LockedOut.mp4',           vo: null,            dur: 337, text: { line1: 'GONE.', line2: null, font: 'Impact', colour: '#8B0000', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'desaturated',  kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'GONE impact' },
  { id: 'EP3_S041', act: 'act4', clip: 'EP3_18A_ACT4_CoinDeskArticle.mp4',       vo: 'VO_Act4.mp3',  dur: 360, text: { line1: 'NOVEMBER 2, 2022', line2: 'THE ARTICLE THAT STARTED EVERYTHING', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'cold_blue',    kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'CoinDesk article' },
  { id: 'EP3_S042', act: 'act4', clip: 'EP3_18B_ACT4_CoinDeskArticle.mp4',       vo: null,            dur: 330, stat: { label: 'ALAMEDA BALANCE SHEET', value: 'MOSTLY FTT TOKENS', sub: 'Self-issued self-controlled collateral' }, grade: 'cold_blue',    kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Balance sheet stat' },
  { id: 'EP3_S043', act: 'act4', clip: 'EP3_19A_ACT4_CZTweet.mp4',               vo: 'VO_Act4.mp3',  dur: 320, text: { line1: 'NOVEMBER 6, 2022', line2: 'CZ DROPS THE MATCH', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'red_alert',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'CZ tweet' },
  { id: 'EP3_S044', act: 'act4', clip: 'EP3_19B_ACT4_CZTweet.mp4',               vo: null,            dur: 310, stat: { label: 'BINANCE SELLING', value: '$500 MILLION FTT', sub: 'CZ tweet November 6 2022' }, grade: 'red_alert',    kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'CZ stat' },
  { id: 'EP3_S045', act: 'act4', clip: 'EP3_20A_ACT4_BankRun.mp4',               vo: 'VO_Act4.mp3',  dur: 330, text: { line1: '72 HOURS', line2: '$6 BILLION IN WITHDRAWALS', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'red_alert',    kb: { start_scale: 1.0, end_scale: 1.10, direction: 'zoom_in' }, notes: 'Bank run' },
  { id: 'EP3_S046', act: 'act4', clip: 'EP3_20B_ACT4_BankRun.mp4',               vo: null,            dur: 300, text: { line1: 'THE MONEY WAS NOT THERE.', line2: null, font: 'Impact', colour: '#8B0000', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'red_alert',    kb: { start_scale: 1.10, end_scale: 1.0, direction: 'zoom_out' }, notes: 'IMPACT WORD' },
  { id: 'EP3_S047', act: 'act4', clip: 'EP3_34A_ACT4_TwitterMeltdown.mp4',       vo: 'VO_Act4.mp3',  dur: 340, text: { line1: 'SBF ON TWITTER', line2: 'FTX IS FINE. ASSETS ARE FINE.', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'cold_blue',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'SBF tweets' },
  { id: 'EP3_S048', act: 'act4', clip: 'EP3_21A_ACT4_BinanceDeal.mp4',           vo: 'VO_Act4.mp3',  dur: 350, text: { line1: 'BINANCE RESCUE ATTEMPT', line2: 'LETTER OF INTENT — THEN WITHDRAWAL', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'cold_blue',    kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Binance deal' },
  { id: 'EP3_S049', act: 'act4', clip: 'EP3_21B_ACT4_BinanceDeal.mp4',           vo: null,            dur: 310, text: { line1: 'BEYOND REPAIR.', line2: null, font: 'Impact', colour: '#8B0000', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'red_alert',    kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'BEYOND REPAIR' },
  { id: 'EP3_S050', act: 'act4', clip: 'EP3_22A_ACT4_FTXCollapseBuilding.mp4',   vo: 'VO_Act4.mp3',  dur: 370, text: { line1: 'NOVEMBER 11, 2022', line2: 'FTX FILES FOR BANKRUPTCY', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'red_alert',    kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Building cracking' },
  { id: 'EP3_S051', act: 'act4', clip: 'EP3_22B_ACT4_FTXCollapseBuilding.mp4',   vo: null,            dur: 330, stat: { label: 'FTX BANKRUPTCY', value: '$32 BILLION', sub: 'Collapsed in 9 days' }, grade: 'red_alert',    kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Collapse stat' },
  { id: 'EP3_S052', act: 'act4', clip: 'EP3_35A_ACT4_BankruptcyFiling.mp4',      vo: null,            dur: 320, text: null, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Bankruptcy doc' },
  { id: 'EP3_S053', act: 'act4', clip: 'EP3_23A_ACT4_SBFResigns.mp4',            vo: 'VO_Act4.mp3',  dur: 350, text: { line1: 'JOHN RAY III', line2: 'COMPLETE FAILURE OF CORPORATE CONTROLS', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, lower: { name: 'JOHN RAY III', title: 'CEO FTX Post-Collapse · Previously: Enron', fade_in_frames: 12, hold_frames: 90, fade_out_frames: 12 }, grade: 'deep_shadow', kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'John Ray' },
  { id: 'EP3_S054', act: 'act4', clip: 'EP3_36A_ACT5_JohnRayIII.mp4',            vo: null,            dur: 320, text: null, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'John Ray docs' },
  { id: 'EP3_S055', act: 'act4', clip: 'EP3_24A_ACT4_SBFArrested.mp4',           vo: 'VO_Act4.mp3',  dur: 350, text: { line1: 'DECEMBER 12, 2022', line2: 'ARRESTED IN THE BAHAMAS', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'red_alert',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Arrest scene' },
  { id: 'EP3_S056', act: 'act4', clip: 'EP3_24B_ACT4_SBFArrested.mp4',           vo: null,            dur: 318, text: { line1: '7 FEDERAL CHARGES.', line2: null, font: 'Impact', colour: '#C9A84C', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'deep_shadow',  kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: '7 charges' },
  { id: 'EP3_S057', act: 'act5', clip: 'EP3_25A_ACT5_Courtroom.mp4',             vo: 'VO_Act5.mp3',  dur: 330, text: { line1: 'OCTOBER 2023', line2: 'THE SOUTHERN DISTRICT OF NEW YORK', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'neutral_dark', kb: { start_scale: 1.0, end_scale: 1.06, direction: 'pan_right' }, notes: 'Courtroom' },
  { id: 'EP3_S058', act: 'act5', clip: 'EP3_25B_ACT5_Courtroom.mp4',             vo: null,            dur: 300, text: null, grade: 'neutral_dark', kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Push to defendant' },
  { id: 'EP3_S059', act: 'act5', clip: 'EP3_26A_ACT5_EllisonTestimony.mp4',      vo: 'VO_Act5.mp3',  dur: 320, text: { line1: 'CAROLINE ELLISON', line2: 'STAR WITNESS FOR THE PROSECUTION', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, lower: { name: 'CAROLINE ELLISON', title: 'Prosecution Witness — Pleaded Guilty', fade_in_frames: 12, hold_frames: 90, fade_out_frames: 12 }, grade: 'neutral_dark', kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Ellison testimony' },
  { id: 'EP3_S060', act: 'act5', clip: 'EP3_26B_ACT5_EllisonTestimony.mp4',      vo: null,            dur: 290, text: null, grade: 'neutral_dark', kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Ellison 2' },
  { id: 'EP3_S061', act: 'act5', clip: 'EP3_27A_ACT5_SBFDefense.mp4',            vo: 'VO_Act5.mp3',  dur: 320, text: { line1: 'SBF ON THE STAND', line2: 'I MADE MISTAKES. NOT CRIMES.', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'SBF defense' },
  { id: 'EP3_S062', act: 'act5', clip: 'EP3_27B_ACT5_SBFDefense.mp4',            vo: null,            dur: 290, text: { line1: 'THE JURY DID NOT BELIEVE HIM.', line2: null, font: 'Impact', colour: '#FFFFFF', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 72, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Jury foreshadow' },
  { id: 'EP3_S063', act: 'act5', clip: 'EP3_28A_ACT5_Verdict.mp4',               vo: 'VO_Act5.mp3',  dur: 330, text: { line1: 'NOVEMBER 2, 2023', line2: 'ONE YEAR LATER — EXACTLY', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Verdict slip' },
  { id: 'EP3_S064', act: 'act5', clip: 'EP3_28B_ACT5_Verdict.mp4',               vo: null,            dur: 270, text: { line1: 'GUILTY.', line2: null, font: 'Impact', colour: '#8B0000', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'red_alert',    kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'GUILTY impact' },
  { id: 'EP3_S065', act: 'act5', clip: 'EP3_28A_ACT5_Verdict.mp4',               vo: null,            dur: 240, text: { line1: 'ALL 7 COUNTS.', line2: null, font: 'Impact', colour: '#8B0000', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 96, letter_spacing: 8 }, grade: 'red_alert',    kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'ALL 7 COUNTS' },
  { id: 'EP3_S066', act: 'act5', clip: 'EP3_29A_ACT5_Sentencing.mp4',            vo: 'VO_Act5.mp3',  dur: 320, text: { line1: 'MARCH 2024', line2: '25 YEARS IN FEDERAL PRISON', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'neutral_dark', kb: { start_scale: 1.0, end_scale: 1.08, direction: 'zoom_in' }, notes: 'Gavel falling' },
  { id: 'EP3_S067', act: 'act5', clip: 'EP3_29B_ACT5_Sentencing.mp4',            vo: null,            dur: 290, stat: { label: 'SENTENCE', value: '25 YEARS', sub: 'Federal Prison — Eligible for release age 57' }, grade: 'neutral_dark', kb: { start_scale: 1.08, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Sentencing stat' },
  { id: 'EP3_S068', act: 'act5', clip: 'EP3_30A_ACT5_PrisonGates.mp4',           vo: 'VO_Act5.mp3',  dur: 340, text: { line1: 'SAM BANKMAN-FRIED', line2: 'AGE 32 — FEDERAL PRISON', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'desaturated',  kb: { start_scale: 1.0, end_scale: 1.04, direction: 'zoom_in' }, notes: 'Prison gates' },
  { id: 'EP3_S069', act: 'act5', clip: 'EP3_30B_ACT5_PrisonGates.mp4',           vo: null,            dur: 300, text: null, grade: 'desaturated',  kb: { start_scale: 1.04, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Pull back gates' },
  { id: 'EP3_S070', act: 'act5', clip: 'EP3_37A_ACT5_CryptoLandscape.mp4',       vo: 'VO_Act5.mp3',  dur: 310, text: { line1: 'THE AFTERMATH', line2: '1 MILLION+ CUSTOMERS STILL WAITING', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'neutral_dark', kb: { start_scale: 1.0, end_scale: 1.06, direction: 'pan_right' }, notes: 'Crypto landscape' },
  { id: 'EP3_S071', act: 'act5', clip: 'EP3_37B_ACT5_CryptoLandscape.mp4',       vo: 'VO_Act5.mp3',  dur: 300, text: null, grade: 'neutral_dark', kb: { start_scale: 1.06, end_scale: 1.0, direction: 'pan_left' }, notes: 'Crypto landscape 2' },
  { id: 'EP3_S072', act: 'act5', clip: 'EP3_02A_ACT1_SBF-Portrait.mp4',          vo: 'VO_Act5.mp3',  dur: 290, text: { line1: 'THE ALTRUISTIC BILLIONAIRE', line2: 'THE GREATEST COVER STORY EVER DEVISED', font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'desaturated',  kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Callback Act 1' },
  { id: 'EP3_S073', act: 'act5', clip: 'EP3_30A_ACT5_PrisonGates.mp4',           vo: 'VO_Act5.mp3',  dur: 280, text: { line1: 'HE CONVINCED THE WORLD HE WAS A SAINT.', line2: null, font: 'Impact', colour: '#C9A84C', position: 'center', fade_in_frames: 4, fade_out_frames: 6, font_size: 60, letter_spacing: 4 }, grade: 'desaturated',  kb: { start_scale: 1.04, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Core irony' },
  { id: 'EP3_S074', act: 'act5', clip: 'EP3_40A_ACT5_OUTRO_CrackingEarth.mp4',   vo: 'VO_Act5.mp3',  dur: 320, text: { line1: 'THE STORIES THEY PAID TO KEEP QUIET.', line2: null, font: 'Bebas Neue', colour: '#C9A84C', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.0, end_scale: 1.06, direction: 'zoom_in' }, notes: 'Outro tagline' },
  { id: 'EP3_S075', act: 'act5', clip: 'EP3_40B_ACT5_OUTRO_CrackingEarth.mp4',   vo: null,            dur: 294, text: { line1: 'SUBSCRIBE', line2: 'NEW DOCUMENTARY EVERY SUNDAY 10AM EST', font: 'Bebas Neue', colour: '#FFFFFF', position: 'bottom_left', fade_in_frames: 12, fade_out_frames: 8, font_size: 52, letter_spacing: 4 }, grade: 'deep_shadow',  kb: { start_scale: 1.06, end_scale: 1.0, direction: 'zoom_out' }, notes: 'Subscribe card' },
];

let cursor = 0;
const scenes = [];

for (const def of SCENE_DEFS) {
  const startFrame = cursor;
  const endFrame = cursor + def.dur;
  cursor = endFrame;

  scenes.push({
    scene_id: def.id,
    timecode_start_frame: startFrame,
    timecode_end_frame: endFrame,
    timecode_start_tc: framesToTC(startFrame),
    timecode_end_tc: framesToTC(endFrame),
    duration_seconds: Math.round(def.dur / FPS * 10) / 10,
    clip_file: def.clip,
    vo_file: def.vo || null,
    vo_start_offset_frames: 0,
    text_overlay: def.text || null,
    lower_third: def.lower || null,
    stat_card: def.stat || null,
    music_volume: 0.15,
    transition_in: { type: 'cut', duration_frames: 0 },
    transition_out: { type: 'cut', duration_frames: 0 },
    ken_burns: def.kb,
    colour_grade: def.grade,
    watermark: { visible: true, opacity: 0.70, position: 'bottom_right' },
    notes: def.notes || '',
  });
}

const totalFrames = cursor;

const editingScript = {
  meta: {
    project: 'Empire Omitted',
    episode: 3,
    title: 'The $32 Billion Lie: How FTX Collapsed Overnight',
    version: '2.0',
    created: 'June 2026',
    fps: FPS,
    resolution: '1920x1080',
    total_frames: totalFrames,
    total_duration_seconds: Math.round(totalFrames / FPS),
    total_duration_tc: framesToTC(totalFrames),
    total_scenes: scenes.length,
  },
  audio: {
    vo_act1_start: ACT_STARTS.act1,
    vo_act2_start: ACT_STARTS.act2,
    vo_act3_start: ACT_STARTS.act3,
    vo_act3b_start: ACT_STARTS.act3b,
    vo_act4_start: ACT_STARTS.act4,
    vo_act5_start: ACT_STARTS.act5,
  },
  scenes,
};

fs.writeFileSync(
  'EmpireOmitted_Ep3_EditingScript.json',
  JSON.stringify(editingScript, null, 2)
);

console.log('');
console.log('✅ Updated editing script saved');
console.log(`Total frames: ${totalFrames}`);
console.log(`Total duration: ${framesToTC(totalFrames)}`);
console.log(`Total scenes: ${scenes.length}`);
console.log('');
console.log('Act timing:');
console.log(`  Act 1:  frame 0 → ${ACT_STARTS.act2}`);
console.log(`  Act 2:  frame ${ACT_STARTS.act2} → ${ACT_STARTS.act3}`);
console.log(`  Act 3:  frame ${ACT_STARTS.act3} → ${ACT_STARTS.act3b}`);
console.log(`  Act 3B: frame ${ACT_STARTS.act3b} → ${ACT_STARTS.act4}`);
console.log(`  Act 4:  frame ${ACT_STARTS.act4} → ${ACT_STARTS.act5}`);
console.log(`  Act 5:  frame ${ACT_STARTS.act5} → ${totalFrames}`);