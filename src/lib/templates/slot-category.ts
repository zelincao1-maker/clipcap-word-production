const SLOT_CATEGORY_LABEL_MAP: Record<string, string> = {
  vehicle_plate_number: '汽车牌照',
  plate_number: '汽车牌照',
  car_plate_number: '汽车牌照',
  license_plate: '汽车牌照',
  vehicle_brand: '汽车品牌',
  car_brand: '汽车品牌',
  auto_brand: '汽车品牌',
  vehicle_model: '车型',
  car_model: '车型',
  auto_model: '车型',
  contract_number: '合同编号',
  bank_card_number: '银行卡号',
  id_card_number: '身份证号',
  identity_card_number: '身份证号',
  phone_number: '联系电话',
  mobile_number: '联系电话',
  address: '住址',
  birth_date: '出生日期',
  birthdate: '出生日期',
  gender: '性别',
  ethnicity: '民族',
  amount: '金额',
  date: '日期',
  interest_rate: '利率',
};

function normalizeKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_');
}

export function normalizeSlotCategoryLabel(value: string) {
  const normalized = normalizeKey(value);

  return SLOT_CATEGORY_LABEL_MAP[normalized] ?? value;
}
