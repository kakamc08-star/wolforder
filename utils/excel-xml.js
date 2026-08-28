'use strict';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeSheetName(value, usedNames) {
  const base = String(value || 'صنف')
    .replace(/[\\/?*\[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28) || 'صنف';
  let candidate = base;
  let suffix = 1;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${base.slice(0, 28 - String(suffix).length)}-${suffix}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function cell(value, styleId) {
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  const type = isNumber ? 'Number' : 'String';
  const style = styleId ? ` ss:StyleID="${styleId}"` : '';
  return `<Cell${style}><Data ss:Type="${type}">${escapeXml(value)}</Data></Cell>`;
}

function worksheet(name, headers, rows) {
  const headerRow = `<Row>${headers.map(value => cell(value, 'Header')).join('')}</Row>`;
  const dataRows = rows.map(row => `<Row>${row.map(value => cell(value)).join('')}</Row>`).join('');
  return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${headerRow}${dataRows}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><RightToLeft/><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions></Worksheet>`;
}

function buildInventoryWorkbook(summaryRows, productGroups) {
  const usedNames = new Set(['ملخص الأصناف']);
  const summaryHeaders = ['الشركة', 'الصنف', 'اللون', 'المقاس', 'الكمية الأساسية', 'المباعة', 'المحجوزة', 'المؤجلة', 'الملغية', 'المرتجعة', 'المتبقية'];
  const detailHeaders = ['رقم الطلب', 'التاريخ', 'الزبون', 'الهاتف', 'العنوان', 'الصنف', 'اللون', 'المقاس', 'الكمية', 'نوع الطلب', 'الحالة', 'الشركة'];
  const sheets = [worksheet('ملخص الأصناف', summaryHeaders, summaryRows)];

  for (const group of productGroups) {
    sheets.push(worksheet(safeSheetName(group.name, usedNames), detailHeaders, group.rows));
  }

  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center" ss:Horizontal="Right"/><Font ss:FontName="Arial" ss:Size="11"/></Style><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#0F766E" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center"/></Style></Styles>${sheets.join('')}</Workbook>`;
}

module.exports = { buildInventoryWorkbook, escapeXml, safeSheetName };
